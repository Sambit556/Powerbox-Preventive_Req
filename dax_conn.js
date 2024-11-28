const AmazonDaxClient = require('amazon-dax-client');  // Import the amazon-dax-client library
const AWS = require('aws-sdk');

// Initialize the DAX client
const daxClient = new AmazonDaxClient({
    endpoints: 'dax://dax.sc5mbt.dax-clusters.ap-southeast-1.amazonaws.com',  // Replace with your DAX cluster endpoint
    region: 'ap-southeast-1',  // Replace with your AWS region
    port: 8111
});

// Initialize DocumentClient with DAX
const docClient = new AWS.DynamoDB.DocumentClient({ service: daxClient });

const TABLE_NAME = "DynamoDBTableName";  // Replace with your DynamoDB table name

exports.handler = async (event) => {
    console.log('Incoming event:', JSON.stringify(event));

    const response = {
        statusCode: 200,
        body: JSON.stringify('Request processed successfully'),
    };

    try {
        const { httpMethod, path } = event; // Extract method and path
        console.log(`httpMethod: ${httpMethod}, path: ${path}`);

        // if (httpMethod === "POST" && path === '/config/addSlavedevices') {
        // Parse the body
        const body = event.body;
        console.log(event, body, "Sam")

        // Validate that the 'devices' array is provided
        // if (!body || Array.isArray(body.devices)) {
        //     throw new Error("'devices' array is required in the request body.");
        // }

        // Process each device and insert into DynamoDB using DAX
        for (const device of event.devices) {
            const params = {
                TableName: "YourDynamoDBTableName",  // Replace with your DynamoDB table name
                Item: {
                    id: device.id,       // Device ID
                    name: device.name,   // Device name
                    timestamp: new Date().toISOString(),  // Timestamp
                },
            };

            // Insert the item into DynamoDB using DAX
            await docClient.put(params).promise();
        }

        response.body = JSON.stringify({
            message: 'Devices added successfully!',
        });
        // } else {
        // Default response for unsupported paths/methods
        // response.statusCode = 404;
        // response.body = JSON.stringify({ message: 'Path not found' });
        // }
    } catch (error) {
        console.error('Error processing request:', error);
        response.statusCode = 500;
        response.body = JSON.stringify({ message: 'Error processing data', error: error.message });
    }

    return response;
};

