const { verifyJWTToken } = require('./middleware_main');  // Import the verify function


async function checkTableExistence(tableName) {
    const dynamodb = new AWS.DynamoDB();
    try {
        await dynamodb.describeTable({ TableName: tableName }).promise();
        return true;
    } catch (error) {
        if (error.code === 'ResourceNotFoundException') {
            return false;
        }
        throw error;
    }
}
async function createTable(tableName) {
    const params = {
        TableName: tableName,
        KeySchema: [
            { AttributeName: 'id', KeyType: 'HASH' },  // Partition key
        ],
        AttributeDefinitions: [
            { AttributeName: 'id', AttributeType: 'S' },  // String type for the id
        ],
        ProvisionedThroughput: {
            ReadCapacityUnits: 5,
            WriteCapacityUnits: 5,
        },
    };

    try {
        await dynamodb.createTable(params).promise();
        console.log(`Table ${tableName} created successfully.`);
    } catch (error) {
        console.error(`Error creating table ${tableName}:`, error);
        throw error;
    }
}
exports.handler = async (event) => {
    const httpMethod = event.httpMethod;
    const path = event.path;
    const response = {
        statusCode: 200,
        body: JSON.stringify('Request processed successfully'),
    };
    
    const authHeader = event.headers.Authorization || event.headers.authorization;

    if (!authHeader) {
        return {
            statusCode: 401,
            body: JSON.stringify({ error: 'Authorization token is missing.' }),
        };
    }
    // Only process GET request for /getSwitchgear
    if (httpMethod === 'GET' && path === '/getSwitchgears') {
        try {
            // Get the authorization token from headers (Assuming Bearer Token)

            // Verify JWT Token using the helper function
            const decodedToken = verifyJWTToken(authHeader);
            const userId = decodedToken.userId;  // Extract userId from the decoded token

            const TABLE_NAME = 'CustomerTable';  // Replace with your DynamoDB table name

            // Check if the table exists
            const tableExists = await checkTableExistence(TABLE_NAME);
            if (!tableExists) {
                return {
                    statusCode: 404,
                    body: JSON.stringify({ message: `Table ${TABLE_NAME} does not exist.` }),
                };
            }

            // Fetch data for the given userId from the table
            const params = {
                TableName: TABLE_NAME,
                Key: { customer_id: userId },  // Assuming 'customer_id' is the primary key
            };

            const result = await ddb.get(params).promise();

            if (!result.Item) {
                return {
                    statusCode: 404,
                    body: JSON.stringify({ message: `Customer with ID ${userId} not found.` }),
                };
            }

            // If the customer exists, return the switchgear name and id
            const switchgears = result.Item.switchgears || [];
            const switchgearDetails = switchgears.map(switchgear => ({
                swiggearName: switchgear.swiggearName,
                id: switchgear.id
            }));

            response.body = JSON.stringify({
                customerId: userId,
                switchgears: switchgearDetails,
            });
            response.statusCode = 200;
        } catch (error) {
            console.error('Error:', error);
            response.statusCode = 500;
            response.body = JSON.stringify({ message: 'Internal Server Error', error: error.message });
        }
    }
    else if (httpMethod === 'GET' && path === '/cbracker/{name}') {
        try {
            const { name } = event.pathParameters || {}; 
            // Verify the JWT token and extract userId
            const decodedToken = verifyJWTToken(authHeader);
            const customerId = decodedToken.userId;  // Extract the userId from the decoded token

            const params = {
                TableName: 'switchgearConfig_Store',
                Key: {
                    id: customerId,  // Using customerId as the primary key (id)
                },
            };

            // Check if the table exists
            const tableExists = await checkTableExistence(params.TableName);
            if (!tableExists) {
                return {
                    statusCode: 404,
                    body: JSON.stringify({ error: `Table ${params.TableName} does not exist.` }),
                };
            }

            // Fetch the customer data from DynamoDB
            const result = await ddb.get(params).promise();

            // Check if the customer exists and has switchgear data
            if (result.Item && result.Item.switchgear && result.Item.switchgear.length > 0) {
                // If switchgear exists, check if the switchgear name matches
                if (result.Item.name === name) {
                    // Extract the required details from the switchgear
                    const extractedData = result.Item.configuredCBs.map(cb => ({
                        name: cb.name || null,
                        serialNo: cb.serialNo || null,
                        brand: cb.brand || null,
                        model: cb.model || null,
                        joNoMfgDate: cb.joNoMfgDate || null,
                        location: cb.location || null,
                    }));

                    return {
                        statusCode: 200,
                        body: JSON.stringify({ configuredCBs: extractedData }),
                    };
                } else {
                    return {
                        statusCode: 404,
                        body: JSON.stringify({ error: 'Switchgear not found or name does not match.' }),
                    };
                }
            } else {
                return {
                    statusCode: 404,
                    body: JSON.stringify({ error: 'No switchgear found for the customer.' }),
                };
            }
        } catch (error) {
            console.error('Error:', error);
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Internal Server Error', message: error.message }),
            };
        }
    }
    else if (httpMethod === 'PUT' && path === '/cbracker/{switchgearid}/{cbId}') {

        const tableName = 'switchgearConfig_Store';  // DynamoDB table name
        const { switchgearid, cbId } = event.pathParameters;  // Extract switchgearid and cbId from path parameters
        if (!cbId || !switchgearid) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Switchgear ID and CB ID are required.' }),
            };
        }
        try {
            // Check if the table exists
            const tableExists = await checkTableExistence(tableName);
            if (!tableExists) {
                return {
                    statusCode: 404,
                    body: JSON.stringify({ error: `Table ${tableName} does not exist.` }),
                };
            }

            // Fetch the customer's data using customerId (now extracted from JWT)
            const params = {
                TableName: tableName,
                Key: {
                    customer_id: customerId,  // Using customer_id from JWT as the partition key
                },
            };

            const result = await ddb.get(params).promise();

            if (!result.Item) {
                return {
                    statusCode: 404,
                    body: JSON.stringify({ error: `Customer with ID ${customerId} not found.` }),
                };
            }

            // Check if the switchgear exists for this customer
            const switchgear = result.Item.switchgearConfigs.find(
                sg => sg.id === switchgearid
            );

            if (!switchgear) {
                return {
                    statusCode: 404,
                    body: JSON.stringify({ error: `Switchgear with ID ${switchgearid} not found for customer ${customer_id}.` }),
                };
            }

            // Find the Circuit Breaker (CB) by cbId and update it
            const cbIndex = switchgear.configuredCBs.findIndex(cb => cb.id === parseInt(cbId));

            if (cbIndex === -1) {
                return {
                    statusCode: 404,
                    body: JSON.stringify({ error: 'Circuit Breaker not found' }),
                };
            }

            // Update the CB with the data provided in the request body
            switchgear.configuredCBs[cbIndex] = { ...switchgear.configuredCBs[cbIndex], ...JSON.parse(body) };

            // Update the switchgear item with the modified CB
            const updateParams = {
                TableName: tableName,
                Key: { customer_id: customer_id },
                UpdateExpression: 'SET switchgearConfigs = :updatedSwitchgearConfigs',
                ExpressionAttributeValues: {
                    ':updatedSwitchgearConfigs': result.Item.switchgearConfigs.map(sg =>
                        sg.id === switchgearid
                            ? { ...sg, configuredCBs: switchgear.configuredCBs }
                            : sg
                    ),
                },
                ReturnValues: 'UPDATED_NEW',
            };

            const updateResult = await ddb.update(updateParams).promise();

            return {
                statusCode: 200,
                body: JSON.stringify({
                    message: 'Circuit Breaker updated successfully.',
                    updatedData: updateResult.Attributes,
                }),
            };
        } catch (error) {
            console.error('Error updating Circuit Breaker:', error);
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Internal Server Error' }),
            };
        }
    }
    else if (httpMethod === 'DELETE' && path === '/cbracker/{switchgearid}/{cbId}') {
        const { switchgearid, cbId } = event.pathParameters;
        // const { customer_id } = event.requestContext.authorizer.claims; // Extract customer_id from JWT

        try {
            const customer_id = decodedToken.userId;
            // Check if the table exists
            const tableExists = await checkTableExistence(tableName);
            if (!tableExists) {
                return {
                    statusCode: 404,
                    body: JSON.stringify({ error: `Table ${tableName} does not exist.` }),
                };
            }

            // Fetch the customer's switchgear data
            const params = {
                TableName: tableName,
                Key: { customer_id: customer_id }, // Partition key is customer_id
            };

            const result = await ddb.get(params).promise();

            if (!result.Item) {
                return {
                    statusCode: 404,
                    body: JSON.stringify({ error: `Customer with ID ${customer_id} not found.` }),
                };
            }

            // Check if the switchgear exists
            const switchgearIndex = result.Item.switchgearConfigs.findIndex(sg => sg.id === switchgearid);

            if (switchgearIndex === -1) {
                return {
                    statusCode: 404,
                    body: JSON.stringify({ error: `Switchgear with ID ${switchgearid} not found for customer ${customer_id}.` }),
                };
            }

            const switchgear = result.Item.switchgearConfigs[switchgearIndex];

            // Check if the CB exists in the switchgear
            const updatedCBs = switchgear.configuredCBs.filter(cb => cb.id !== parseInt(cbId, 10));
            if (updatedCBs.length === switchgear.configuredCBs.length) {
                return {
                    statusCode: 404,
                    body: JSON.stringify({ error: `Circuit Breaker with ID ${cbId} not found in Switchgear ${switchgearid}.` }),
                };
            }

            // Update the switchgear to remove the CB
            const updateParams = {
                TableName: tableName,
                Key: { customer_id: customer_id },
                UpdateExpression: 'SET switchgearConfigs = :updatedSwitchgearConfigs',
                ExpressionAttributeValues: {
                    ':updatedSwitchgearConfigs': result.Item.switchgearConfigs.map(sg =>
                        sg.id === switchgearid
                            ? { ...sg, configuredCBs: updatedCBs }
                            : sg
                    ),
                },
                ReturnValues: 'UPDATED_NEW',
            };

            const updateResult = await ddb.update(updateParams).promise();

            return {
                statusCode: 200,
                body: JSON.stringify({
                    message: 'Circuit Breaker successfully deleted.',
                    updatedData: updateResult.Attributes,
                }),
            };
        } catch (error) {
            console.error('Error deleting Circuit Breaker:', error);
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Internal Server Error' }),
            };
        }
    }
    
    else {
        response.statusCode = 404;
        response.body = JSON.stringify({ message: "Endpoint not found or unsupported HTTP method" });
    }

    return response;
};
