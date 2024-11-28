const AWS = require("aws-sdk");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const { HTML_STATUS_CODE } = require("./constant.js");
const { verifyJWT } = require("./middleware.js");

const ddb = new AWS.DynamoDB.DocumentClient();
const DynamoDBclient = new AWS.DynamoDB({ region: "ap-southeast-1" });

async function checkTableExistence(tableName) {
    try {
        await DynamoDBclient.describeTable({ TableName: tableName }).promise();
        return true;
    } catch (error) {
        if (error.code === "ResourceNotFoundException") {
            return false;
        }
        throw error;
    }
}

// Utility function to format nested objects for PDFs
function formatNestedObject(doc, object, indent = 0) {
    const indentation = " ".repeat(indent * 2);
    for (const [key, value] of Object.entries(object)) {
        if (typeof value === "object" && value !== null) {
            doc.text(`${indentation}${key}:`);
            formatNestedObject(doc, value, indent + 1);
        } else {
            doc.text(`${indentation}${key}: ${value}`);
        }
    }
}

exports.handler = async (event) => {
    const { httpMethod, path, headers, pathParameters, body } = event;

    try {
        const user = verifyJWT(headers); // Validate JWT and extract user info

        // POST /switchgearConfig
        if (httpMethod === "POST" && path === "/switchgearConfig") {
            const { switchgearConfig } = JSON.parse(body);
            if (!switchgearConfig || !switchgearConfig.id) {
                return {
                    statusCode: HTML_STATUS_CODE.BAD_REQUEST,
                    body: JSON.stringify({ error: "Field 'ID' is required." }),
                };
            }

            const params = {
                TableName: "switchgearConfig_Store",
                Item: {
                    id: switchgearConfig.id,
                    name: switchgearConfig.name,
                    maxCBs: switchgearConfig.maxCBs,
                    configuredCBs: switchgearConfig.configuredCBs,
                    customerName: user.customerName, // Add customer name from JWT
                    cust_id: user.cust_id, // Add customer ID from JWT
                    timestamp: new Date().toISOString(),
                },
            };

            await ddb.put(params).promise();
            return {
                statusCode: HTML_STATUS_CODE.CREATED,
                body: JSON.stringify({ message: "Data successfully saved." }),
            };
        }

        // GET /switchgears
        if (httpMethod === "GET" && path === "/switchgears") {
            const params = { TableName: "switchgearType" };
            const tableExists = await checkTableExistence(params.TableName);
            if (!tableExists) {
                return {
                    statusCode: HTML_STATUS_CODE.NOT_FOUND,
                    body: JSON.stringify({
                        error: `Table ${params.TableName} does not exist.`,
                    }),
                };
            }

            const result = await ddb.scan(params).promise();
            if (result.Items.length === 0) {
                return {
                    statusCode: HTML_STATUS_CODE.NOT_FOUND,
                    body: JSON.stringify({ error: "No switchgears found." }),
                };
            }

            return {
                statusCode: HTML_STATUS_CODE.SUCCESS,
                body: JSON.stringify(result.Items),
            };
        }

        // GET /{switchgearid}/{cbId}
        if (httpMethod === "GET" && path.startsWith("/")) {
            const { switchgearid, cbId } = pathParameters || {};
            if (!switchgearid || !cbId) {
                return {
                    statusCode: HTML_STATUS_CODE.BAD_REQUEST,
                    body: JSON.stringify({
                        error: "Switchgear ID and CB ID are required.",
                    }),
                };
            }

            const params = {
                TableName: "switchgearConfig_Store",
                Key: { id: switchgearid },
            };
            const data = await ddb.get(params).promise();
            if (!data.Item) {
                return {
                    statusCode: HTML_STATUS_CODE.NOT_FOUND,
                    body: JSON.stringify({ error: "Switchgear not found." }),
                };
            }

            const circuitBreaker = data.Item.configuredCBs.find(
                (cb) => cb.id === parseInt(cbId, 10)
            );
            if (!circuitBreaker) {
                return {
                    statusCode: HTML_STATUS_CODE.NOT_FOUND,
                    body: JSON.stringify({ error: "Circuit Breaker not found." }),
                };
            }

            // Generate PDF
            const pdfFilePath = `/tmp/CB_${cbId}_${switchgearid}_Details.pdf`;
            const doc = new PDFDocument();
            doc.pipe(fs.createWriteStream(pdfFilePath));
            doc.fontSize(18).text("Circuit Breaker Details", { underline: true });
            doc.moveDown();
            doc.fontSize(14).text(`Switchgear ID: ${switchgearid}`);
            doc.text(`Circuit Breaker ID: ${cbId}`);
            doc.moveDown();

            for (const [key, value] of Object.entries(circuitBreaker)) {
                if (key === "configurations") {
                    doc.text(`${key}:`);
                    formatNestedObject(doc, value, 1);
                } else {
                    doc.text(`${key}: ${value}`);
                }
            }

            doc.end();
            const pdfBuffer = fs.readFileSync(pdfFilePath);

            return {
                statusCode: HTML_STATUS_CODE.SUCCESS,
                headers: {
                    "Content-Type": "application/pdf",
                    "Content-Disposition": `attachment; filename=CB_${cbId}_${switchgearid}_Details.pdf`,
                },
                body: pdfBuffer.toString("base64"),
                isBase64Encoded: true,
            };
        }

        // Default response for unsupported routes
        return {
            statusCode: HTML_STATUS_CODE.NOT_FOUND,
            body: JSON.stringify({ error: "Route not found." }),
        };
    } catch (error) {
        console.error("Error handling request:", error);
        return {
            statusCode: HTML_STATUS_CODE.INTERNAL_ERROR,
            body: JSON.stringify({ error: error.message || "Internal Server Error" }),
        };
    }
};