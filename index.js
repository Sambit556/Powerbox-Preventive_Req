const express = require('express');
const AWS = require('aws-sdk');
const bodyParser = require('body-parser');
const cors = require('cors');
const moment = require("moment");


const app = express();
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(bodyParser.json());

AWS.config.update({
    region: 'ap-southeast-1',
    endpoint: 'http://localhost:8000',
});
const DynamoDBclient = new AWS.DynamoDB({ region: 'ap-southeast-1' });
const ddb = new AWS.DynamoDB.DocumentClient();

async function checkTableExistence(tableName) {
    try {
        // Check if the table exists
        await DynamoDBclient.describeTable({ TableName: tableName }).promise();
        console.log(`Table "${tableName}" already exists.`);
    } catch (error) {
        if (error.code === 'ResourceNotFoundException') {
            console.log(`Table "${tableName}" not found. Creating it...`);

            // Define table creation parameters
            const createTableParams = {
                TableName: tableName,
                KeySchema: [
                    { AttributeName: 'customer_id', KeyType: 'HASH' }, // Partition key
                ],
                AttributeDefinitions: [
                    { AttributeName: 'customer_id', AttributeType: 'S' }, // String type for partition key
                ],
                ProvisionedThroughput: {
                    ReadCapacityUnits: 5,
                    WriteCapacityUnits: 5,
                },
            };

            // Create the table
            await DynamoDBclient.createTable(createTableParams).promise();
            console.log(`Table "${tableName}" created successfully.`);
        } else {
            console.error('Error checking or creating the table:', error);
            throw error; // Throw unexpected errors
        }
    }
}

// --------------------------------------------------------------------
app.post('/switchgearConfig/:id/:name', async (req, res) => {
    const { id, name } = req.params;
    const { configswitchgears } = req.body;

    // Validate input
    if (!id || !name || !Array.isArray(configswitchgears) || configswitchgears.length === 0) {
        return res.status(400).json({
            error: "Fields 'id', 'name', and 'configswitchgears' are required, and 'configswitchgears' must be a non-empty array.",
        });
    }

    const tableName = 'switchgearConfig_Store';

    try {
        await checkTableExistence(tableName)
        // Step 1: Retrieve the existing data from DynamoDB
        const getParams = {
            TableName: tableName,
            Key: { customer_id: id },
        };

        const existingData = await ddb.get(getParams).promise();

        let existingConfigs = [];
        if (existingData.Item) {
            existingConfigs = existingData.Item.configswitchgears || [];
        }

        // Step 2: Check for duplicate 'name' in the configuredCBs
        for (const switchgear of configswitchgears) {
            for (const newCB of switchgear.configuredCBs) {
                const isDuplicate = existingConfigs.some(existingSwitchgear =>
                    existingSwitchgear.name === switchgear.name &&
                    existingSwitchgear.configuredCBs.some(existingCB => existingCB.name === newCB.name)
                );

                if (isDuplicate) {
                    return res.status(400).json({
                        error: `Circuit breaker with name '${newCB.name}' already exists in the switchgear '${switchgear.name}'.`,
                    });
                }
            }
        }

        // Step 3: Append new data
        const updatedConfigs = [...existingConfigs];

        for (const newSwitchgear of configswitchgears) {
            const existingSwitchgear = updatedConfigs.find(
                (switchgear) => switchgear.name === newSwitchgear.name
            );

            if (existingSwitchgear) {
                // Append new CBs to the existing switchgear
                existingSwitchgear.configuredCBs.push(...newSwitchgear.configuredCBs);
            } else {
                // Add new switchgear entirely
                updatedConfigs.push(newSwitchgear);
            }
        }

        // Step 4: Save updated data back to DynamoDB
        const putParams = {
            TableName: tableName,
            Item: {
                customer_id: id,
                name,
                configswitchgears: updatedConfigs,
                timestamp: new Date().toISOString(),
            },
        };

        await ddb.put(putParams).promise();

        // Respond with success
        res.status(201).json({
            message: "Data successfully appended and saved.",
            updatedConfigs,
        });
    } catch (err) {
        console.error('Error saving data:', err);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

app.get('/switchgearConfig/:id/:deviceId', async (req, res) => {
    const { id, deviceId } = req.params;
    const tableName = 'switchgearConfig_Store'

    const params = {
        TableName: tableName,
        Key: {
            customer_id: id,
        },
    };

    try {

        const result = await ddb.get(params).promise();

        if (result.Item && Array.isArray(result.Item.configswitchgears)) {
            // Find the specific switchgear configuration matching the given `switchgear`

            const matchingSwitchgear = result.Item.configswitchgears.find(
                (config) => config.id === deviceId
            );

            if (matchingSwitchgear && Array.isArray(matchingSwitchgear.configuredCBs)) {
                // Extract details of configured CBs
                const extractedData = matchingSwitchgear.configuredCBs.map(cb => ({
                    name: cb.name || null,
                    id: cb.id || null,
                    serialNo: cb.serialNo || null,
                    brand: cb.brand || null,
                    model: cb.model || null,
                    joNoMfgDate: cb.joNoMfgDate || null,
                    location: cb.location || null,
                    configurations: cb.configurations || null,
                }));
                return res.status(200).json({ configuredCB: extractedData });
            } else {
                return res.status(201).json({
                    message: "No matching switchgear or configured CBs found.",
                    configuredCB: []
                });
            }
        } else {
            return res.status(404).json({ error: "No switchgear configurations found." });
        }
    } catch (error) {
        console.error('Error fetching data:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.delete('/removeCB/:id/:switchgearid/:cbId', async (req, res) => {
    const { id, switchgearid, cbId } = req.params;
    const tableName = 'switchgearConfig_Store';

    if (!id || !switchgearid || !cbId) {
        return res.status(400).json({ error: 'id, switchgearid, and cbId are required.' });
    }

    try {

        // Fetch the item from DynamoDB
        const params = {
            TableName: tableName,
            Key: { customer_id: id },
        };

        const result = await ddb.get(params).promise();

        // Check if the item exists
        if (!result.Item) {
            return res.status(404).json({ error: 'Switchgear configuration not found.' });
        }

        let { configswitchgears } = result.Item;

        // Check if configswitchgears exists and is an array
        if (!Array.isArray(configswitchgears)) {
            return res.status(500).json({ error: 'Invalid data format for switchgear configurations.' });
        }

        // Find the specified switchgear
        const matchingSwitchgear = configswitchgears.find((config) => config.id === switchgearid);
        if (!matchingSwitchgear) {
            return res.status(404).json({ error: 'Switchgear not found for the given ID.' });
        }

        // Filter out the circuit breaker with the specified `cbId`
        const updatedCBs = (matchingSwitchgear.configuredCBs || []).filter((cb) => cb.id !== parseInt(cbId, 10));
        if (updatedCBs.length === (matchingSwitchgear.configuredCBs || []).length) {
            return res.status(404).json({ error: 'Circuit breaker not found for the given ID.' });
        }

        // Update the switchgear's configuredCBs
        matchingSwitchgear.configuredCBs = updatedCBs;

        // Update the DynamoDB record
        const updateParams = {
            TableName: tableName,
            Key: { customer_id: id },
            UpdateExpression: 'SET configswitchgears = :configswitchgears',
            ExpressionAttributeValues: {
                ':configswitchgears': configswitchgears,
            },
            ReturnValues: 'UPDATED_NEW',
        };

        const updateResult = await ddb.update(updateParams).promise();

        res.status(200).json({
            message: 'Circuit breaker deleted successfully.',
            updatedConfigSwitchgears: updateResult.Attributes.configswitchgears,
        });
    } catch (error) {
        console.error('Error deleting circuit breaker:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});


app.put('/updateCB/:id/:switchgearid/:cbId', async (req, res) => {
    const { updatedCB } = req.body;
    const { id, switchgearid, cbId } = req.params;
    const tableName = 'switchgearConfig_Store';

    if (!id || !switchgearid || !cbId || !updatedCB) {
        return res.status(400).json({ error: 'id, switchgearid, cbId, and updatedCB are required.' });
    }

    try {
        await checkTableExistence(tableName);

        // Fetch the item from DynamoDB
        const params = {
            TableName: tableName,
            Key: { customer_id: id },
        };

        const result = await ddb.get(params).promise();
        if (!result.Item) {
            return res.status(404).json({ error: 'Switchgear configuration not found.' });
        }

        // Use the correct key name `configswitchgears` from your data format
        let { configswitchgears } = result.Item;

        // Check if `configswitchgears` exists and is an array
        if (!Array.isArray(configswitchgears)) {
            return res.status(500).json({ error: 'Invalid data format for switchgear configurations.' });
        }

        // Find the specified switchgear
        const matchingSwitchgear = configswitchgears.find((config) => config.id === switchgearid);
        if (!matchingSwitchgear) {
            return res.status(404).json({ error: 'Switchgear not found for the given ID.' });
        }

        // Find the circuit breaker to be updated
        const cbIndex = (matchingSwitchgear.configuredCBs || []).findIndex((cb) => cb.id === parseInt(cbId, 10));
        if (cbIndex === -1) {
            return res.status(404).json({ error: 'Circuit breaker not found for the given ID.' });
        }

        // Update the circuit breaker with new data
        matchingSwitchgear.configuredCBs[cbIndex] = { ...matchingSwitchgear.configuredCBs[cbIndex], ...updatedCB };

        // Update the DynamoDB record
        const updateParams = {
            TableName: tableName,
            Key: { customer_id: id },
            UpdateExpression: 'SET configswitchgears = :configswitchgears',
            ExpressionAttributeValues: {
                ':configswitchgears': configswitchgears,
            },
            ReturnValues: 'UPDATED_NEW',
        };

        const updateResult = await ddb.update(updateParams).promise();

        res.status(200).json({
            message: 'Circuit breaker updated successfully.',
            updatedConfigSwitchgears: updateResult.Attributes.configswitchgears,
        });
    } catch (error) {
        console.error('Error updating circuit breaker:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// -------------------------------------------------------------------------
app.post("/preventivetask", async (req, res) => {
    const { customer_id, customer_name, tasks } = req.body;
    const tableName = "Preventive_mentainance_Storage";

    // Validate input
    if (!customer_id || !customer_name || !tasks || !Array.isArray(tasks)) {
        return res.status(400).json({
            error: "'customerId', 'customer_name', and 'tasks' (non-empty array) are required.",
        });
    }

    try {
        await checkTableExistence(tableName)
        // Prepare the item to save
        const item = {
            customer_id: customer_id,
            customer_name,
            tasks,
            timestamp: new Date().toISOString(),
        };

        const params = {
            TableName: tableName,
            Item: item,
        };

        // Save the item to DynamoDB
        await ddb.put(params).promise();

        res.status(201).json({ message: "Tasks successfully saved." });
    } catch (err) {
        console.error("Error saving tasks:", err);
        res.status(500).json({ error: "Internal server error." });
    }
});

app.get("/preventivetask/:customerId", async (req, res) => {
    const { customerId } = req.params;
    const tableName = "Preventive_mentainance_Storage";

    // Validate input
    if (!customerId) {
        return res.status(400).json({
            error: "'customerId' is required.",
        });
    }

    try {
        const getParams = {
            TableName: tableName,
            Key: {
                customer_id: customerId,
            },
        };

        const data = await ddb.get(getParams).promise();

        if (!data.Item) {
            return res.status(404).json({ error: "Customer's task not found." });
        }

        const tasks = data.Item.tasks;


        res.status(200).json({
            message: "Task showed successfully.",
            configData: tasks,
        });
    } catch (err) {
        console.error("Error updating task or subtask:", err);
        res.status(500).json({ error: "Internal server error." });
    }
});

app.put("/preventivetask/:customerId", async (req, res) => {
    const { customerId } = req.params;
    const { tasks_id, updates } = req.body;
    const tableName = "Preventive_mentainance_Storage";

    if (!customerId || !tasks_id || !updates) {
        return res.status(400).json({
            error: "'customerId', 'tasks_id', and 'updates' are required.",
        });
    }

    try {
        await checkTableExistence(tableName)
        const getParams = {
            TableName: tableName,
            Key: {
                customer_id: customerId,
            },
        };

        const data = await ddb.get(getParams).promise();

        if (!data.Item) {
            return res.status(404).json({ error: "Customer's task not found." });
        }

        // Locate the task and subtask to update
        const tasks = data.Item.tasks;
        const taskIndex = tasks.findIndex((task) => task.id === tasks_id);

        if (taskIndex === -1) {
            return res.status(404).json({ error: "Task not found." });
        }

        const task = tasks[taskIndex];

        // Prevent mainTask update if isCustom is false
        if (!task.isCustom || updates.mainTask || updates.isCustom || updates.id) {
            return res.status(400).json({
                error: "Cannot update this field for this task.",
            });
        }
        tasks[taskIndex] = {
            ...task,
            ...updates,
        };


        // Update the record in DynamoDB
        const updateParams = {
            TableName: tableName,
            Key: {
                customer_id: customerId,
            },
            UpdateExpression: "SET tasks = :tasks",
            ExpressionAttributeValues: {
                ":tasks": tasks,
            },
            ReturnValues: "ALL_NEW",
        };

        const result = await ddb.update(updateParams).promise();

        res.status(200).json({
            message: "Task or subtask updated successfully.",
            updatedData: result.Attributes,
        });
    } catch (err) {
        console.error("Error updating task or subtask:", err);
        res.status(500).json({ error: "Internal server error." });
    }
});

app.delete("/preventivetask/:customerId", async (req, res) => {
    const { customerId } = req.params;
    const { tasks_id } = req.body;
    const tableName = "Preventive_mentainance_Storage";

    if (!customerId || !tasks_id) {
        return res.status(400).json({
            error: "'customerId','tasks_id' is required.",
        });
    }
    try {
        const getParams = {
            TableName: tableName,
            Key: {
                customer_id: customerId,
            },
        };

        const data = await ddb.get(getParams).promise();

        if (!data.Item) {
            return res.status(404).json({ error: "Customer's task not found." });
        }

        // Locate the task
        const tasks = data.Item.tasks;
        const taskIndex = tasks.findIndex((task) => task.id === tasks_id);

        if (taskIndex === -1) {
            return res.status(404).json({ error: "Task not found." });
        }

        const task = tasks[taskIndex];

        // Prevent deletion if the task is not custom
        if (!task.isCustom) {
            return res.status(400).json({
                error: "Cannot delete task for this.",
            });
        }
        // Delete the entire task
        tasks.splice(taskIndex, 1);

        // Update the record in DynamoDB
        const updateParams = {
            TableName: tableName,
            Key: {
                customer_id: customerId,
            },
            UpdateExpression: "SET tasks = :tasks",
            ExpressionAttributeValues: {
                ":tasks": tasks,
            },
            ReturnValues: "ALL_NEW",
        };

        const result = await ddb.update(updateParams).promise();

        res.status(200).json({
            message: "Task deleted successfully.",
            updatedData: result.Attributes,
        });
    } catch (err) {
        console.error("Error deleting task or subtask:", err);
        res.status(500).json({ error: "Internal server error." });
    }

});
// -------------------------------------------------
app.post('/getSubtasks', async (req, res) => {
    const { customer_id, planSchedule } = req.body;
    const tableName = 'Preventive_mentainance_Storage';

    if (!customer_id || !planSchedule) {
        return res.status(400).json({ error: 'customer_id and planSchedule are required.' });
    }

    try {
        await checkTableExistence(tableName)
        // Fetch customer data from the database
        const params = {
            TableName: tableName,
            Key: { customer_id },
        };

        const result = await ddb.get(params).promise();

        if (!result.Item) {
            return res.status(404).json({ error: 'Customer not found.' });
        }

        const { tasks } = result.Item;

        if (!tasks || tasks.length === 0) {
            return res.status(404).json({ error: 'No tasks found for the customer.' });
        }

        // Filter tasks based on the given planSchedule and group by mainTask
        const groupedSubTasks = tasks.reduce((acc, task) => {
            const filteredSubTasks = task.subTasks.filter(subTask => subTask.planSchedule === planSchedule);

            if (filteredSubTasks.length > 0) {
                acc.push({
                    id: task.id,
                    mainTask: task.mainTask,
                    subTasks: filteredSubTasks.map(subTask => ({
                        name: subTask.name,
                        timeDuration: subTask.timeDuration,
                    })),
                });
            }

            return acc;
        }, []);

        if (groupedSubTasks.length === 0) {
            return res.status(404).json({ error: 'No subtasks found with the specified planSchedule.' });
        }

        // Send the response with grouped subtasks
        res.status(200).json(groupedSubTasks);
    } catch (error) {
        console.error('Error fetching subtasks:', error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});
app.post("/insertmapData", async (req, res) => {
    const TABLE_NAME = "Preventive_mappping_Storage";
    try {
        const { customer_id, switchgears } = req.body;

        // Validate input
        if (!customer_id || !Array.isArray(switchgears)) {
            return res.status(400).json({
                message: "Invalid input. 'customer_id' and 'switchgears' are required, and 'switchgears' must be an array.",
            });
        }

        // Check table existence
        await checkTableExistence(TABLE_NAME);

        // Retrieve existing data for the customer
        const getParams = {
            TableName: TABLE_NAME,
            Key: { customer_id },
        };
        const existingData = await ddb.get(getParams).promise();

        let switchgears_arr = [];
        if (existingData.Item) {
            switchgears_arr = existingData.Item.switchgears || [];
        }

        // Iterate through the incoming switchgears array to update or add new data
        switchgears.forEach((newSwitchgear) => {
            const existingSwitchgear = switchgears_arr.find(
                (sg) => sg.switchgearId === newSwitchgear.switchgearId
            );

            if (existingSwitchgear) {
                // Update the existing switchgear's CBs
                newSwitchgear.cbs.forEach((newCb) => {
                    const existingCb = existingSwitchgear.cbs.find(
                        (cb) => cb.taskId === newCb.taskId
                    );

                    if (existingCb) {
                        // Update the existing CB with new data
                        Object.assign(existingCb, newCb);
                    } else {
                        // Add the new CB to the existing switchgear
                        existingSwitchgear.cbs.push(newCb);
                    }
                });
            } else {
                // Add a new switchgear
                switchgears_arr.push(newSwitchgear);
            }
        });

        // Prepare updated data for DynamoDB
        const updateParams = {
            TableName: TABLE_NAME,
            Item: {
                customer_id, // Partition key
                switchgears: switchgears_arr, // Updated switchgears array
            },
        };

        // Update the table
        await ddb.put(updateParams).promise();

        res.status(200).json({
            message: "Data inserted/updated successfully!",
            data: updateParams.Item,
        });
    } catch (error) {
        console.error("Error:", error);
        res.status(500).json({
            message: "Failed to insert/update data",
            error: error.message,
        });
    }
});

app.get('/getMappingData', async (req, res) => {
    try {
        const { customer_id, device_id, cbName } = req.query;
        const Map_ConfigTable = "Preventive_mappping_Storage";
        const CB_ConfigTable = "switchgearConfig_Store";

        if (!customer_id) {
            return res.status(400).json({ message: "'customer_id' is required." });
        }

        // Fetch CB_ConfigTable data
        const ConfigParams = {
            TableName: CB_ConfigTable,
            Key: { customer_id },
        };

        const cbConfigResult = await ddb.get(ConfigParams).promise();
        if (!cbConfigResult.Item) {
            return res.status(404).json({ message: "No data found for the given customer_id in CB_ConfigTable." });
        }

        if (!device_id) {
            const switchgears = cbConfigResult.Item.configswitchgears.map(switchgear => ({
                id: switchgear.id,
                name: switchgear.name,
                // configuredCBs: switchgear.configuredCBs.map(cb => cb.name) // List only CB names
            }));

            return res.status(200).json({
                message: 'Switchgears fetched successfully.',
                customer_id,
                switchgears,
            });
        }
        // Search for the matching device
        const matchingDevice = cbConfigResult.Item.configswitchgears.find(switchgear => switchgear.id === device_id);
        if (!matchingDevice) {
            return res.status(404).json({ message: "For that Device ID not CB's found." });
        }

        if (!cbName) {
            // Extract only the CB names
            const cbNames = matchingDevice.configuredCBs.map(cb => ({ Cb_Name: cb.name, Cb_Id: cb.id }));
            return res.status(200).json({
                message: 'Circuit breaker names for the device:',
                cbNames,
            });
        }

        // Fetch Map_ConfigTable data
        const mapConfigParams = {
            TableName: Map_ConfigTable,
            Key: { customer_id },
        };
        let allCBsTaskID = []
        const mapConfigResult = await ddb.get(mapConfigParams).promise();

        if (!mapConfigResult.Item) {
            return res.status(200).json({ message: "No data found for the given customer_id in Map_ConfigTable.", count: 0, allCBsTaskID });
        }

        const matchingSwitchgear = mapConfigResult.Item.switchgears.find(switchgear => {
            if (switchgear.switchgearId === device_id) {
                return switchgear
            }
        });

        if (!matchingSwitchgear) {
            return res.status(200).json({ message: `No CB's planshudule found with name '${cbName}' in the switchgears`, count: 0, allCBsTaskID });
        }

        // Aggregate CB data
        const matchingCBs = matchingSwitchgear.cbs.filter(cb => cb.cbname === cbName);

        matchingCBs.forEach(cb => {
            if (cb.taskId) {
                allCBsTaskID.push(cb.taskId); // Push only the taskId
            }
        });

        const planshudules = [...new Set(matchingCBs.map(cb => cb.planshudule))];
        const today = new Date().toISOString().split("T")[0];
        const cbCreatedTodayCount = matchingCBs.filter(cb => cb.creationDate.startsWith(today)).length;

        return res.status(200).json({
            message: "CB planshudule fetched successfully.",
            cbname: cbName,
            planshudule: planshudules,
            count: cbCreatedTodayCount,
            allCBsTaskID: allCBsTaskID
        });
    } catch (error) {
        console.error("Error:", error);
        res.status(500).json({
            message: "Failed to fetch data",
            error: error.message,
        });
    }
});

app.get('/switchgear/:customer_id/:switchgearId', async (req, res) => {
    const { customer_id, switchgearId } = req.params;
    const { taskId } = req.query; // Extract taskId from query parameters
    const TableName = "Preventive_mappping_Storage";

    // DynamoDB params to fetch the data by customer_id
    const params = {
        TableName: TableName,
        Key: { customer_id },
    };

    try {
        // Check if the table exists before querying
        await checkTableExistence(TableName);

        // Retrieve data from DynamoDB
        const result = await ddb.get(params).promise();

        // Ensure the 'Item' exists in the result from DynamoDB
        if (!result.Item) {
            return res.status(404).json({ error: "Customer don't mapped yet" });
        }

        // Check if the switchgears array exists and find the specific switchgear by name
        const switchgear = result.Item.switchgears.find(sg => sg.switchgearId === switchgearId);

        // If the switchgear is not found
        if (!switchgear) {
            return res.status(404).json({ error: "Switchgear don't mapped yet" });
        }

        // If taskId is provided in query
        if (taskId) {
            const task = switchgear.cbs.find(cb => cb.taskId === taskId);
            if (!task) {
                return res.status(404).json({ error: "TaskId not found in this switchgear" });
            }

            // Return specific task details
            return res.status(200).json({
                message: "Task details fetched successfully.",
                task: {
                    taskId: task.taskId,
                    cbname: task.cbname,
                    cbid: task.cbid,
                    pms_des: task.pms_des,
                    planshudule: task.planshudule,
                    fromDate: task.planStartDate,
                    toDate: task.planEndDate,
                    tasks: task.tasks,
                },
            });
        }

        // Return switchgear details if taskId is not provided
        const switchgearDetails = {
            swiggearName: switchgear.switchgearName,
            swiggearId: switchgear.switchgearId,
            cbs: switchgear.cbs.map(cb => ({
                taskId: cb.taskId,
                cbname: cb.cbname,
                cbid: cb.cbid,
                pms_des: cb.pms_des,
                planshudule: cb.planshudule,
                fromDate: cb.planStartDate,
                toDate: cb.planEndDate,
                tasks: cb.tasks,
            })),
        };

        return res.status(200).json({
            message: "Mapped Switchgear fetched successfully.",
            switchgear: switchgearDetails,
        });
    } catch (err) {
        console.error("Error:", err);
        return res.status(500).json({ error: 'Failed to retrieve switchgear data' });
    }
});

app.put('/switchgear/:id/:switchgearId/:taskId', async (req, res) => {
    const { id, switchgearId, taskId } = req.params;
    const { fromDate, toDate, tasks } = req.body;

    const allowedFields = ['fromDate', 'toDate', 'tasks'];
    const TableName = "Preventive_mappping_Storage";

    // Validate request body fields
    const bodyFields = Object.keys(req.body);
    const invalidFields = bodyFields.filter(field => !allowedFields.includes(field));
    if (invalidFields.length > 0) {
        return res.status(400).json({ error: `Invalid fields: ${invalidFields.join(', ')}` });
    }

    if (!taskId) {
        return res.status(400).json({ error: "'taskId' is required to update data." });
    }

    const params = {
        TableName,
        Key: { customer_id: id },
    };

    try {
        await checkTableExistence(TableName);

        // Retrieve the item from DynamoDB
        const result = await ddb.get(params).promise();

        // Check if the customer exists
        if (!result.Item) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        // Locate the switchgear by name
        const switchgear = result.Item.switchgears.find(sg => sg.switchgearId === switchgearId);
        if (!switchgear) {
            return res.status(404).json({ error: 'Switchgear not found' });
        }

        // Locate the CB containing the task with the provided taskId
        const taskToUpdate = switchgear.cbs.find(cb =>
            cb.taskId == taskId
        );

        if (!taskToUpdate) {
            return res.status(404).json({ error: `No CB found with taskId '${taskId}' in the specified switchgear.` });
        }

        let updated = false;
        const today = new Date().toISOString().split('T')[0]; // Today's date in YYYY-MM-DD format

        // Update 'fromDate' if it matches today's date
        if (fromDate) {

            if (taskToUpdate.planStartDate >= today) {
                taskToUpdate.planStartDate = fromDate;
                updated = true;
            } else {
                return res.status(400).json({
                    error: `Cannot update 'fromDate' because it does not match today's date (${today}).`,
                });
            }
        }

        // Update 'toDate' unconditionally
        if (toDate) {
            taskToUpdate.planEndDate = toDate;
            updated = true;
        }

        // update the tasks and it's end-date's
        if (taskToUpdate.tasks && tasks) taskToUpdate.tasks = tasks;

        // If nothing was updated
        if (!updated) {
            return res.status(400).json({ error: 'No valid fields provided for update.' });
        }

        // Save the updated data back to DynamoDB
        const updatedParams = {
            TableName,
            Key: { customer_id: id },
            UpdateExpression: 'SET switchgears = :switchgears',
            ExpressionAttributeValues: {
                ':switchgears': result.Item.switchgears,
            },
        };

        await ddb.update(updatedParams).promise();

        return res.status(200).json({
            message: 'Task data updated successfully.',
            updatedTask: taskToUpdate
        });
    } catch (err) {
        console.error("Error:", err);
        return res.status(500).json({ error: 'Failed to update switchgear data' });
    }
});

app.delete('/switchgear/:id/:switchgearId/:taskId', async (req, res) => {
    const { id, switchgearId, taskId } = req.params;
    const TableName = "Preventive_mappping_Storage";

    // DynamoDB params to fetch the data
    const params = {
        TableName,
        Key: { customer_id: id },
    };

    try {
        // Retrieve the customer data from DynamoDB
        const result = await ddb.get(params).promise();

        // Check if the customer exists
        if (!result.Item) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        // Check if the switchgears array exists and find the specific switchgear
        const switchgearIndex = result.Item.switchgears.findIndex(sg => sg.switchgearId === switchgearId);

        if (switchgearIndex === -1) {
            return res.status(404).json({ error: 'Switchgear not found' });
        }

        // Find the specific taskId (Circuit Breaker) within the switchgear
        const cbIndex = result.Item.switchgears[switchgearIndex].cbs.findIndex(cb => cb.taskId === taskId);

        if (cbIndex === -1) {
            return res.status(404).json({ error: 'Circuit Breaker not found' });
        }

        // Remove the circuit breaker (taskId) from the array
        result.Item.switchgears[switchgearIndex].cbs.splice(cbIndex, 1);

        // Prepare updated data for saving in DynamoDB
        const updateParams = {
            TableName,
            Key: { customer_id: id },
            UpdateExpression: 'SET switchgears = :switchgears',
            ExpressionAttributeValues: {
                ':switchgears': result.Item.switchgears,
            },
        };

        // Update the DynamoDB table
        await ddb.update(updateParams).promise();

        return res.status(200).json({
            message: `Circuit Breaker '${taskId}' deleted successfully from Switchgear '${switchgearId}'.`,
        });
    } catch (err) {
        console.error("Error:", err);
        return res.status(500).json({ error: 'Failed to delete Circuit Breaker' });
    }
});

app.get('/testpreservice/:table/:customer_id', async (req, res) => {
    const { table, customer_id } = req.params;
    const { planType, scheduleType, ...extraParams } = req.query;

    const preventiveTable = "Preventive_mappping_Storage";
    const configurationTable = "switchgearConfig_Store";
    const calendarTasksTable = "calander_Tasks_Update";

    if (Object.keys(extraParams).length > 0) {
        return res.status(400).json({
            error: "Unexpected parameters",
            unexpectedParams: Object.keys(extraParams)
        });
    }

    if (!table || !customer_id || !planType) {
        return res.status(400).json({
            error: "'table', 'customer_id', and 'planType' are required."
        });
    }

    try {
        // Fetch customer data from the preventive table
        const preventiveParams = {
            TableName: preventiveTable,
            Key: { customer_id },
        };
        const preventiveResult = await ddb.get(preventiveParams).promise();

        if (!preventiveResult.Item) {
            return res.status(404).json({ error: 'Customer not found in Preventive table' });
        }

        const switchgears = preventiveResult.Item.switchgears || [];

        // Fetch configuration data from the configuration table
        const configParams = {
            TableName: configurationTable,
            Key: { customer_id },
        };
        const configResult = await ddb.get(configParams).promise();

        if (!configResult.Item) {
            return res.status(404).json({ error: 'Customer not found in Configuration table' });
        }

        const configSwitchgears = configResult.Item.configswitchgears || [];

        // Fetch calendar tasks from the calendar tasks update table
        const calendarParams = {
            TableName: calendarTasksTable,
            Key: { customer_id },
        };
        const calculateDays = (date1, date2, lastDigit) => {
            const diff = new Date(date1) - new Date(date2);
            const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
            return Math.round(days / lastDigit);
        };
        const convertToshudule = (planshudule) => {
            const lastDigit = parseInt(planshudule.match(/\d+$/)?.[0] || "1", 10);
            return lastDigit;
        };

        const convertToDate = (dateObj) =>
            `${dateObj.year}-${String(dateObj.month).padStart(2, '0')}-${String(dateObj.day).padStart(2, '0')}`;

        const calendarResult = await ddb.get(calendarParams).promise();

        let calendarConfigurations = [];
        if (calendarResult.Item) {

            calendarConfigurations = calendarResult.Item.configurations || [];
        }

        // Helper function to get status, validation, and approved values for a taskId
        const getTaskDetails = (taskId, maintaskName, taskName) => {
            if (calendarConfigurations) {
                for (const config of calendarConfigurations) {
                    for (const switchgear of config.switchgears) {
                        for (const cb of switchgear.cbs) {
                            if (cb.taskId === taskId) {
                                for (const task of cb.tasks) {
                                    const results = [];
                                    if (task.mainTask === maintaskName) {
                                        task.subTasks.forEach(subTask => {
                                            if (subTask.name === taskName) {
                                                results.push({
                                                    status: subTask.status || "false",
                                                    validation: subTask.validation ?? "false",
                                                    comments: subTask.comments ?? "no"
                                                });
                                            }
                                        });
                                    }
                                    return results;
                                }
                            }
                        }
                    }
                }
            }
            return { status: "not found", validation: "not found", comments: "not found" };
        };

        const getsubTask_length = (taskId, mainTaskName) => {
            for (const switchgear of switchgears) {
                for (const cb of switchgear.cbs) {
                    if (cb.taskId === taskId) {
                        for (const task of cb.tasks) {
                            if (task.mainTask === mainTaskName) {
                                return task.subTasks ? task.subTasks.length : 0;
                            }
                        }
                    }
                }
            }
            return length;
        }

        const matchLocation = (cbid, switchgearId) => {
            for (const config of configSwitchgears) {
                if (config.id === switchgearId) {
                    const cb = config.configuredCBs.find(cb => cb.id === cbid);
                    if (cb) return cb.configurations.equipmentDetails.data.switchgearLocation || 'Unknown Location';
                }
            }
            return 'Unknown Location';
        };

        const filteredSwitchgears = switchgears.map((switchgear) => {
            const cbs = switchgear.cbs || [];
            let filteredCbs = [];

            if (planType === 'Individual') {
                filteredCbs = cbs.map((cb) => {
                    const fetchDetailsform_calander = [];
                    cb.tasks.forEach((task) => {
                        task.subTasks.forEach((subTask) => {
                            const taskDetails = getTaskDetails(cb.taskId, task.mainTask, subTask.name);
                            if (taskDetails && Array.isArray(taskDetails)) {
                                taskDetails.forEach((detail) => {
                                    fetchDetailsform_calander.push({
                                        status: detail.status ?? "no status",
                                        validation: detail.validation ?? "no validation",
                                        comments: detail.comments ?? "no comments",
                                    });
                                });
                            }
                        });
                    });
                    let status, validation;
                    if (Array.isArray(fetchDetailsform_calander) && fetchDetailsform_calander.length > 0) {
                        status = fetchDetailsform_calander.every((item) => item.status === true)
                            ? "completed"
                            : "pending";
                        validation = fetchDetailsform_calander.every(item => item.validation === true)
                            ? "Valid"
                            : "Invalid";
                    }
                    return {
                        cbname: cb.cbname,
                        cbid: cb.cbid,
                        pms_des: cb.pms_des,
                        taskId: cb.taskId,
                        planshudule: cb.planshudule,
                        planEndDate: `${String(cb.planEndDate.month).padStart(2, '0')}-${String(cb.planEndDate.day).padStart(2, '0')}-${cb.planEndDate.year}`,
                        planStartDate: `${String(cb.planStartDate.month).padStart(2, '0')}-${String(cb.planStartDate.day).padStart(2, '0')}-${cb.planStartDate.year}`,
                        status: status ?? 'pending',
                        validation: validation ?? 'Invalid',
                        location: matchLocation(cb.cbid, switchgear.switchgearId),
                    };
                });

            }
            else if (planType === 'Totalplan' && scheduleType) {
                filteredCbs = cbs
                    .filter((cb) => cb.planshudule === scheduleType)
                    .map((cb) => {
                        const fetchDetailsform_calander = [];
                        let subTask_length = 0
                        cb.tasks.forEach((task) => {
                            task.subTasks.forEach((subTask) => {
                                const taskDetails = getTaskDetails(cb.taskId, task.mainTask, subTask.name);
                                subTask_length = getsubTask_length(cb.taskId, task.mainTask);
                                if (taskDetails && Array.isArray(taskDetails)) {
                                    taskDetails.forEach((detail) => {
                                        fetchDetailsform_calander.push({
                                            status: detail.status ?? "no status",
                                            validation: detail.validation ?? "no validation",
                                            comments: detail.comments ?? "no comments",
                                        });
                                    });
                                }
                            });
                        });

                        let pendingPlan, completePlan;
                        if (Array.isArray(fetchDetailsform_calander) && fetchDetailsform_calander.length > 0) {
                            pendingPlan = fetchDetailsform_calander.filter(item => item.status === false).length;
                            completePlan = fetchDetailsform_calander.filter(item => item.status === true).length;
                        }
                        return {
                            cbname: cb.cbname,
                            cbid: cb.cbid,
                            pms_des: cb.pms_des,
                            taskId: cb.taskId,
                            planshudule: cb.planshudule,
                            planStartDate: `${String(cb.planStartDate.month).padStart(2, '0')}-${String(cb.planStartDate.day).padStart(2, '0')}-${cb.planStartDate.year}`,
                            totalPlan: calculateDays(convertToDate(cb.planEndDate), convertToDate(cb.planStartDate), convertToshudule(cb.planshudule)),
                            pendingPlan: pendingPlan ?? subTask_length,
                            completePlan: completePlan ?? 0,
                            location: matchLocation(cb.cbid, switchgear.switchgearId)
                        };
                    });
            } else if (planType === 'Totalplan') {
                filteredCbs = cbs.map((cb) => {
                    const fetchDetailsform_calander = [];
                    let subTask_length = 0;
                    cb.tasks.forEach((task) => {
                        task.subTasks.forEach((subTask) => {
                            const taskDetails = getTaskDetails(cb.taskId, task.mainTask, subTask.name);
                            subTask_length = getsubTask_length(cb.taskId, task.mainTask);
                            if (taskDetails && Array.isArray(taskDetails)) {
                                taskDetails.forEach((detail) => {
                                    fetchDetailsform_calander.push({
                                        status: detail.status ?? "no status",
                                        validation: detail.validation ?? "no validation",
                                        comments: detail.comments ?? "no comments",
                                    });
                                });
                            }
                        });
                    });

                    let pendingPlan, completePlan;
                    if (Array.isArray(fetchDetailsform_calander) && fetchDetailsform_calander.length > 0) {
                        pendingPlan = fetchDetailsform_calander.filter(item => item.status === false).length;
                        completePlan = fetchDetailsform_calander.filter(item => item.status === true).length;
                    }
                    return {
                        cbname: cb.cbname,
                        cbid: cb.cbid,
                        pms_des: cb.pms_des,
                        taskId: cb.taskId,
                        planshudule: cb.planshudule,
                        planStartDate: `${String(cb.planStartDate.month).padStart(2, '0')}-${String(cb.planStartDate.day).padStart(2, '0')}-${cb.planStartDate.year}`,
                        totalPlan: calculateDays(convertToDate(cb.planEndDate), convertToDate(cb.planStartDate), convertToshudule(cb.planshudule)),
                        pendingPlan: pendingPlan ?? subTask_length,
                        completePlan: completePlan ?? 0,
                        location: matchLocation(cb.cbid, switchgear.switchgearId)
                    };
                });
            }
            return { ...switchgear, cbs: filteredCbs };
        });

        const response = {
            customer_id: preventiveResult.Item.customer_id,
            switchgears: filteredSwitchgears,
        };

        return res.status(200).json(response);
    } catch (err) {
        console.error("Error:", err);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});  // not chnaged

// ---------------------------------------------------- calenders --------------------------------
app.get('/api/planshadules', async (req, res) => {
    const { customer_id, switchgearId, planshudule, planstartDate } = req.query;
    const TABLE_NAME = "Preventive_mappping_Storage"
    if (!customer_id) {
        return res.status(400).json({ message: 'customer_id is required' });
    }

    try {
        // Fetch data for the customer_id
        const params = {
            TableName: TABLE_NAME,
            KeyConditionExpression: '#customer_id = :customer_id',
            ExpressionAttributeNames: {
                '#customer_id': 'customer_id'
            },
            ExpressionAttributeValues: {
                ':customer_id': customer_id
            }
        };

        const result = await ddb.query(params).promise();

        if (result.Items.length === 0) {
            return res.status(404).json({ message: 'Customer not found' });
        }
        let switchgears = result.Items[0].switchgears;

        // Filter by switchgearId if provided
        if (switchgearId) {
            switchgears = switchgears.filter(s => s.switchgearId === switchgearId);
        }

        // Filter CBs by planshudule if provided
        if (planshudule) {
            switchgears = switchgears.map(s => {
                s.cbs = s.cbs.filter(cb => cb.planshudule === planshudule);
                return s;
            });
        }
        if (planstartDate) {
            switchgears = switchgears.map(s => {
                s.cbs = s.cbs.filter(cb => {
                    const dateObjstart = `${cb.planStartDate.year}-${String(cb.planStartDate.month).padStart(2, '0')}-${String(cb.planStartDate.day).padStart(2, '0')}`;
                    const dateObjend = `${cb.planEndDate.year}-${String(cb.planEndDate.month).padStart(2, '0')}-${String(cb.planEndDate.day).padStart(2, '0')}`;
                    return dateObjstart <= planstartDate && planstartDate <= dateObjend;
                });
                return s;
            });
        }

        res.json({ customer_id, switchgears });

    } catch (error) {
        console.error('Error fetching data from DynamoDB:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});
// ------------------------------------------------------------
app.get("/Calandertasks", async (req, res) => {
    const { customer_id, switchgearID, cbname, taskid } = req.query;
    const TABLE_NAME = "Preventive_mappping_Storage";
    const CALENDAR_TABLE_NAME = "calander_Tasks_Update";  // Table for calendar tasks

    // Validate input
    if (!customer_id || !switchgearID || !cbname || !taskid) {
        return res.status(400).json({ error: "Missing required parameters: customer_id, switchgearID, cbname, taskid" });
    }

    try {
        // Fetch the customer from Preventive_mappping_Storage table
        const params = {
            TableName: TABLE_NAME,
            Key: { customer_id },
        };
        const calendarParams = {
            TableName: CALENDAR_TABLE_NAME,
            Key: { customer_id },
        };

        const result = await ddb.get(params).promise();
        const calendarResult = await ddb.get(calendarParams).promise();

        if (!result.Item) {
            return res.status(404).json({ error: "Customer not found" });
        }

        // Validate switchgear
        const switchgear = result.Item.switchgears.find(sg => sg.switchgearId === switchgearID);
        if (!switchgear) {
            return res.status(404).json({ error: "Switchgear not found" });
        }

        // Validate CB name and task ID
        const cb = switchgear.cbs.find(cb => cb.cbname === cbname && cb.taskId === taskid);
        if (!cb) {
            return res.status(404).json({ error: "CB or Task not found" });
        }

        const calendarConfigurations = calendarResult.Item?.configurations || [];

        const getTaskDetailsForSubTask = (taskId, mainTaskName, subTaskName) => {
            if (calendarResult) {
                for (const config of calendarConfigurations) {
                    for (const switchgear of config.switchgears) {
                        for (const cb of switchgear.cbs) {
                            if (cb.taskId === taskId) {
                                for (const task of cb.tasks) {
                                    if (task.mainTask === mainTaskName) {
                                        for (const subTask of task.subTasks) {
                                            if (subTask.name === subTaskName) {
                                                return {
                                                    reportRef: subTask.reportRef || "",
                                                    remarks: subTask.remarks || "",
                                                    status: subTask.status || "",
                                                    performedBy: subTask.performedBy || "",
                                                    comments: subTask.comments || "",
                                                };
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            // Default return if no matching subTask found
            return {
                reportRef: "",
                remarks: "",
                status: "",
                performedBy: "",
                comments: ""
            };
        };

        // Update all subTasks for the CB
        const mappedTasks = cb.tasks.map(task => {
            task.subTasks = task.subTasks.map(subTask => {
                const { reportRef, remarks, status, performedBy, comments } = getTaskDetailsForSubTask(taskid, task.mainTask, subTask.name);
                subTask.reportRef = reportRef;
                subTask.remarks = remarks;
                subTask.status = status;
                subTask.performedBy = performedBy;
                subTask.comments = comments;
                return subTask;
            });
            return task;
        });

        // Return the updated tasks
        return res.status(200).json({ tasks: mappedTasks });
    } catch (error) {
        console.error("Error fetching data:", error);
        return res.status(500).json({ error: "Internal server error" });
    }
});

app.get("/getTaskDetails", async (req, res) => {
    const { customer_id, switchgearId, cbname, taskId } = req.query;
    const TABLE_NAME = "Preventive_mappping_Storage";
    // Validate input
    if (!customer_id || !switchgearId || !cbname || !taskId) {
        return res.status(400).json({ error: "Missing required query parameters: customer_id, switchgearId, cbname, taskId" });
    }

    try {
        // Fetch the customer from DynamoDB
        const params = {
            TableName: TABLE_NAME,
            Key: { customer_id },
        };

        const result = await dynamoDb.get(params).promise();

        if (!result.Item) {
            return res.status(404).json({ error: "Customer not found" });
        }

        // Find the switchgear by switchgearId
        const switchgear = result.Item.switchgears.find(
            (sg) => sg.switchgearId === switchgearId
        );

        if (!switchgear) {
            return res.status(404).json({ error: "Switchgear not found" });
        }

        // Find the CB (Circuit Breaker) by cbname and taskId
        const cb = switchgear.cbs.find(
            (cb) => cb.cbname === cbname && cb.taskId === taskId
        );

        if (!cb) {
            return res.status(404).json({ error: "CB or Task not found" });
        }

        // Construct the response with the requested details
        const response = {
            planshudule: cb.planshudule,
            creationDate: cb.creationDate,
            planStartDate: new Date(cb.planStartDate.year, cb.planStartDate.month - 1, cb.planStartDate.day).toISOString(),
            checkList: [
                {
                    description: "Weekly",
                    isCompleted: false, // Example placeholder, can be dynamically adjusted
                },
            ],
            customer_id,
            switchgearName: switchgear.switchgearName || "",
            switchgearId: switchgear.switchgearId,
        };

        res.status(200).json(response);
    } catch (error) {
        console.error("Error fetching data:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.post("/storecalTask", async (req, res) => {
    try {
        const { customer_id, configurations } = req.body;

        // Fetch existing data for the customer_id
        const getParams = {
            TableName: 'calander_Tasks_Update',
            Key: {
                customer_id,
            },
        };

        const existingData = await ddb.get(getParams).promise();

        // Initialize configurations
        let updatedConfigurations = existingData.Item?.configurations || [];

        if (!configurations) return "No data available as input"
        // Process new configurations
        configurations.forEach((newConfig) => {
            const existingConfig = updatedConfigurations.find(
                (config) => config.configure_Ts === newConfig.configure_Ts
            );

            if (existingConfig) {
                // Merge switchgears
                newConfig.switchgears.forEach((newSwitchgear) => {
                    const existingSwitchgear = existingConfig.switchgears.find(
                        (sg) => sg.switchgearID === newSwitchgear.switchgearID
                    );

                    if (existingSwitchgear) {
                        // Merge CBs
                        newSwitchgear.cbs.forEach((newCb) => {
                            const existingCb = existingSwitchgear.cbs.find(
                                (cb) => cb.taskId === newCb.taskId
                            );

                            if (existingCb) {
                                newCb.tasks.forEach((newTask) => {
                                    const existingTask = existingCb.tasks.find(
                                        (task) => task.mainTask === newTask.mainTask
                                    );

                                    if (existingTask) {
                                        newTask.subTasks.forEach((newSubTask) => {
                                            const existingSubTask = existingTask.subTasks.find(
                                                (subTask) => subTask.name === newSubTask.name
                                            );

                                            if (existingSubTask) {
                                                Object.assign(existingSubTask, newSubTask);
                                            } else {
                                                existingTask.subTasks.push(newSubTask);
                                            }
                                        });

                                        Object.assign(existingTask, {
                                            ...newTask,
                                            subTasks: existingTask.subTasks,
                                        });
                                    } else {
                                        existingCb.tasks.push(newTask);
                                    }
                                });
                            } else {
                                // Add new CB if no matching CB found
                                existingSwitchgear.cbs.push(newCb);
                            }

                        });
                    } else {
                        existingConfig.switchgears.push(newSwitchgear);
                    }
                });
            } else {
                updatedConfigurations.push(newConfig);
            }
        });

        const updateParams = {
            TableName: 'calander_Tasks_Update',
            Item: {
                customer_id: customer_id,
                configurations: updatedConfigurations,
            },
        };

        await ddb.put(updateParams).promise();

        res.status(200).send({ message: "Data stored successfully." });
    } catch (error) {
        console.error("Error storing data:", error);
        res.status(500).json({
            message: "Internal server error.",
            error: error.message,
        });
    }
});

app.get('/getcalTask/:customer_id/:configure_Ts/:switchgearID?/:taskId?/:cbid?', async (req, res) => {
    const { customer_id, configure_Ts, switchgearID, taskId } = req.params;

    if (!customer_id || !configure_Ts) {
        return res.status(400).send({ message: 'Customer ID and configure_Ts (date) are required.' });
    }

    const params = {
        TableName: 'calander_Tasks_Update',
        Key: {
            customer_id
        }
    };

    try {
        const data = await ddb.get(params).promise();

        if (!data.Item) {
            return res.status(404).send({ message: 'Customer not found.' });
        }

        // Filter configurations by the given configure_Ts date
        let filteredConfigurations = data.Item.configurations.filter(
            (config) => config.configure_Ts === configure_Ts
        );

        if (filteredConfigurations.length === 0) {
            return res.status(404).send({
                message: `No configurations found for the given date: ${configure_Ts}.`
            });
        }

        if (switchgearID) {
            filteredConfigurations = filteredConfigurations.map(config => {
                const switchgears = config.switchgears.filter(switchgear => switchgear.switchgearID === switchgearID);
                return { ...config, switchgears };
            }).filter(config => config.switchgears.length > 0);
        }

        if (taskId) {
            filteredConfigurations = filteredConfigurations.map(config => {
                config.switchgears = config.switchgears.map(switchgear => {
                    switchgear.cbs = switchgear.cbs.map(cb => {
                        if (cb.taskId === taskId) {
                            return cb;
                        }
                        return null; // Ignore CBs that don't match cbid
                    }).filter(cb => cb !== null);
                    return switchgear;
                }).filter(switchgear => switchgear.cbs.length > 0);
                return config;
            }).filter(config => config.switchgears.length > 0);
        }

        if (filteredConfigurations.length === 0) {
            return res.status(404).send({
                message: `No data found`
            });
        }

        res.status(200).send({
            customer_id: data.Item.customer_id,
            configurations: filteredConfigurations
        });
    } catch (error) {
        console.error('Error retrieving data:', error);
        res.status(500).send({ message: 'Error retrieving data.', error });
    }
});

app.get('/getPlansByCustomer/:customer_id', async (req, res) => {
    const customerId = req.params.customer_id;

    const params = {
        TableName: 'Preventive_mappping_Storage',
        KeyConditionExpression: 'customer_id = :customer_id',
        ExpressionAttributeValues: {
            ':customer_id': customerId,
        },
    };

    try {
        const data = await ddb.query(params).promise();
        if (!data.Items || data.Items.length === 0) {
            return res.status(404).json({ message: 'Customer not found' });
        }
        const result = []
        data.Items.forEach(item => {
            item.switchgears.forEach(sg => {
                sg.cbs.forEach(cb => {
                    const existingCheckList = result.find(r => r.checkListType === cb.planshudule && r.deviceName === sg.switchgearName && r.planStartDate === cb.planStartDate);

                    if (existingCheckList) {
                        existingCheckList.checkList.push({
                            description: cb.pms_des,
                            isCompleted: false
                        });
                    } else {
                        result.push({
                            checkListType: cb.planshudule,
                            date: `${cb.planEndDate.year}-${String(cb.planEndDate.month).padStart(2, '0')}-${String(cb.planEndDate.day).padStart(2, '0')}`,
                            plannedDate: `${cb.planStartDate.year}-${String(cb.planStartDate.month).padStart(2, '0')}-${String(cb.planStartDate.day).padStart(2, '0')}`,
                            checkList: [
                                {
                                    description: cb.pms_des,
                                    isCompleted: false
                                }
                            ],
                            custId: item.customer_id,
                            deviceName: sg.switchgearName,
                            status: "pending",
                            plType: cb.planshudule.replace(/_\d+$/i, ''),
                            id: sg.switchgearId,
                            title: `${sg.switchgearName}-${cb.planshudule}`
                        });
                    }
                });
            });
        });

        const mergedResult = {};

        result.forEach(item => {
            // Create a unique key based on the grouping criteria
            const key = `${item.plannedDate}_${item.date}_${item.checkListType}_${item.id}_${item.custId}_${item.deviceName}`;

            if (!mergedResult[key]) {
                // Initialize the group if not already present
                mergedResult[key] = {
                    plannedDate: item.plannedDate,
                    date: item.date,
                    checkListType: item.checkListType,
                    id: item.id,
                    custId: item.custId,
                    deviceName: item.deviceName,
                    status: item.status,
                    plType: item.plType,
                    title: item.title,
                    checkList: [] // Initialize empty checklist array
                };
            }

            // Merge the checklist details
            mergedResult[key].checkList.push(...item.checkList);
        });

        const finalResult = Object.values(mergedResult);
        if (finalResult.length <= 0) {
            return res.status(404).json({ message: 'No tasks found for the given customer' });
        }
        const resultCount = finalResult.flatMap(obj => {
            const plannedDate = new Date(obj.plannedDate);
            const startDate = new Date(obj.date);
            const daysDiff = (startDate - plannedDate) / (1000 * 60 * 60 * 24); // Difference in days
            const checkListTypeNumber = parseInt(obj.checkListType.match(/\d+$/)?.[0] || "1", 10);
            const objCount = Math.round(daysDiff / checkListTypeNumber);

            if (objCount <= 1) {
                return [obj];
            }

            const copies = [];
            let currentPlannedDate = plannedDate;

            for (let i = 0; i < objCount; i++) {
                const newObj = { ...obj };
                newObj.plannedDate = currentPlannedDate.toISOString().split("T")[0];
                if (i < objCount - 1) {
                    const newDate = new Date(currentPlannedDate);
                    newDate.setDate(newDate.getDate() + checkListTypeNumber);
                    newObj.date = newDate.toISOString().split("T")[0];
                    currentPlannedDate = newDate;
                } else {
                    newObj.date = startDate.toISOString().split("T")[0];
                }
                copies.push(newObj);
            }
            return copies;
        });
        res.json(resultCount ?? []);
    } catch (error) {
        console.error('Error fetching data from DynamoDB:', error);
        res.status(500).json({ error: 'Unable to fetch data from DynamoDB' });
    }
});
//   ----------------------------------------------------------------- configure_Ts (Hardcoded)
app.get('/fetchallData/:customer_id/:switchgearID', async (req, res) => {
    const { customer_id, switchgearID } = req.params;
    const { cbid } = req.query;

    if (!customer_id || !switchgearID) {
        return res.status(400).json({ message: "Missing customer_id or switchgearID in query parameters." });
    }

    try {
        // Fetch from Table 1
        const table1Params = {
            TableName: "calander_Tasks_Update",
            KeyConditionExpression: "customer_id = :customer_id",
            ExpressionAttributeValues: {
                ":customer_id": customer_id
            }
        };
        const table1Result = await ddb.query(table1Params).promise();

        // Fetch from Table 2
        const table2Params = {
            TableName: "switchgearConfig_Store",
            KeyConditionExpression: "customer_id = :customer_id",
            ExpressionAttributeValues: {
                ":customer_id": customer_id
            }
        };
        const table2Result = await ddb.query(table2Params).promise();

        // Fetch from Table 3
        const table3Params = {
            TableName: "Preventive_mappping_Storage",
            KeyConditionExpression: "customer_id = :customer_id",
            ExpressionAttributeValues: {
                ":customer_id": customer_id
            }
        };
        const table3Result = await ddb.query(table3Params).promise();

        // Combine the data into arrays
        let calConfigurations = table1Result.Items.flatMap(item =>
            item.configurations
                .map(config => ({
                    ...config,
                    switchgears: config.switchgears.filter(sg => sg.switchgearID == switchgearID)
                }))
                .filter(config => config.switchgears.length > 0)
        );

        let configSwitchgears = table2Result.Items.map(item => ({
            ...item,
            configswitchgears: item.configswitchgears.filter(sg => sg.id === switchgearID)
        })).filter(item => item.configswitchgears.length > 0);

        let switchgearMappping = table3Result.Items.map(item => ({
            ...item,
            switchgears: item.switchgears.filter(sg => sg.switchgearId === switchgearID)
        })).filter(item => item.switchgears.length > 0);

        let response = {}

        function calConfigurationsfun(calConfigurations, configure_Ts, switchgearID, cbid) {
            const configuration = calConfigurations.find(config => config.configure_Ts === configure_Ts);

            if (!configuration) {
                return { success: false, message: `No configuration found with configure_Ts: ${configure_Ts}` };
            }
            const switchgear = configuration.switchgears.find(sg => sg.switchgearID === switchgearID);
            if (!switchgear) {
                return { success: false, message: `No switchgear found with ID: ${switchgearID} under configuration ${configure_Ts}` };
            }
            const cbDetails = switchgear.cbs.find(cb => cb.cbid === cbid);
            if (!cbDetails) {
                return { success: false, message: `No CB found with ID: ${cbid} under switchgear ${switchgearID}` };
            }
            return cbDetails
        }

        function configSwitchgearsfun(configSwitchgears, switchgearID, cbid) {
            // Iterate through configSwitchgears to find the matching switchgear and cb
            const switchgear = configSwitchgears.find(switchgear =>
                switchgear.configswitchgears.some(configSwitchgear =>
                    configSwitchgear.id === switchgearID // Check if the switchgearId matches
                )
            );

            if (switchgear) {
                // Find the configSwitchgear that matches the given switchgearID
                const configSwitchgear = switchgear.configswitchgears.find(configSwitchgear =>
                    configSwitchgear.id === switchgearID
                );

                if (configSwitchgear) {
                    // Find the CB based on cbid and return it
                    cbDetails = configSwitchgear.configuredCBs.find(cb => cb.id === Number(cbid));
                    return cbDetails;
                }
            }
        }

        function switchgearMapppingfun(switchgearMapping, switchgearId, cbid) {
            // Find the switchgear by switchgearId
            const switchgear = switchgearMapping.find(sg => sg.switchgears.some(sg => sg.switchgearId === switchgearId));

            if (!switchgear) {
                return `No switchgear found with ID: ${switchgearId}`;
            }

            // Find the switchgear that matches switchgearId
            const matchingSwitchgear = switchgear.switchgears.find(sg => sg.switchgearId === switchgearId);

            // Find the CB by cbid
            const cbDetails = matchingSwitchgear.cbs.find(cb => cb.cbid === Number(cbid));

            if (!cbDetails) {
                return `No CB found with ID: ${cbid} under switchgear ${switchgearId}`;
            }

            return cbDetails; // Return the found CB details
        }

        if (cbid) {
            const configure_Ts = "2024-12-16";
            // Filter or map circuit breaker details for the provided cbid
            calConfigurations = calConfigurationsfun(calConfigurations, configure_Ts, switchgearID, cbid);
            configSwitchgears = configSwitchgearsfun(configSwitchgears, switchgearID, cbid);
            switchgearMappping = switchgearMapppingfun(switchgearMappping, switchgearID, cbid);

            response = {
                customer_id,
                switchgearID,
                calConfigurations,
                configSwitchgears,
                switchgearMappping
            };
        }

        // Format the response
        response = {
            customer_id,
            switchgearID,
            calConfigurations,
            configSwitchgears,
            switchgearMappping
        };

        return res.status(200).json(response);

    } catch (error) {
        console.error("Error fetching data:", error);
        res.status(500).json({ message: "Internal Server Error", error });
    }
});  // not used here

app.post('/saveAllData/:customer_id/:switchgearID', async (req, res) => {
    const { customer_id, switchgearID } = req.params;

    if (!customer_id || !switchgearID) {
        return res.status(400).json({ message: "Missing customer_id or switchgearID in the request parameters." });
    }

    try {
        // Query existing data for the customer
        const queryParams = {
            TableName: "customer_data_table",
            KeyConditionExpression: "customer_id = :customer_id",
            ExpressionAttributeValues: {
                ":customer_id": customer_id
            }
        };
        const existingDataResult = await ddb.query(queryParams).promise();

        // Fetch data from the three tables
        const table1Params = {
            TableName: "calander_Tasks_Update",
            KeyConditionExpression: "customer_id = :customer_id",
            ExpressionAttributeValues: {
                ":customer_id": customer_id
            }
        };
        const table1Result = await ddb.query(table1Params).promise();

        const table2Params = {
            TableName: "switchgearConfig_Store",
            KeyConditionExpression: "customer_id = :customer_id",
            ExpressionAttributeValues: {
                ":customer_id": customer_id
            }
        };
        const table2Result = await ddb.query(table2Params).promise();

        const table3Params = {
            TableName: "Preventive_mappping_Storage",
            KeyConditionExpression: "customer_id = :customer_id",
            ExpressionAttributeValues: {
                ":customer_id": customer_id
            }
        };
        const table3Result = await ddb.query(table3Params).promise();

        // Combine data
        let calConfigurations = table1Result.Items.flatMap(item =>
            item.configurations
                .map(config => ({
                    ...config,
                    switchgears: config.switchgears.filter(sg => sg.switchgearID == switchgearID)
                }))
                .filter(config => config.switchgears.length > 0)
        );

        let configSwitchgears = table2Result.Items.map(item => ({
            ...item,
            configswitchgears: item.configswitchgears.filter(sg => sg.id === switchgearID)
        })).filter(item => item.configswitchgears.length > 0);

        let switchgearMappping = table3Result.Items.map(item => ({
            ...item,
            switchgears: item.switchgears.filter(sg => sg.switchgearId === switchgearID)
        })).filter(item => item.switchgears.length > 0);

        // Format new data to save
        const configure_Ts = moment().format('YYYY-MM-DD');
        const newSwitchgearData = {
            switchgearID,
            configure_Ts,
            calConfigurations,
            configSwitchgears,
            switchgearMappping
        };

        // Check if the switchgearID already exists for the customer
        let updatedData;
        if (existingDataResult.Items.length > 0) {
            const existingEntry = existingDataResult.Items[0];
            let existingSwitchgears = existingEntry.switchgears || [];

            // Replace or add new data for the given switchgearID
            const switchgearIndex = existingSwitchgears.findIndex(sg => sg.switchgearID === switchgearID);
            if (switchgearIndex !== -1) {
                // Replace the existing switchgear data
                existingSwitchgears[switchgearIndex] = newSwitchgearData;
            } else {
                // Add new switchgear data
                existingSwitchgears.push(newSwitchgearData);
            }

            updatedData = {
                ...existingEntry,
                switchgears: existingSwitchgears
            };
        } else {
            // Create new entry if no existing data found for the customer
            updatedData = {
                customer_id,
                switchgears: [newSwitchgearData]
            };
        }

        // Save the updated data to the table
        const saveParams = {
            TableName: "customer_data_table",
            Item: updatedData
        };
        await ddb.put(saveParams).promise();

        // Response
        return res.status(201).json({
            message: "Data successfully saved.",
            data: updatedData
        });

    } catch (error) {
        console.error("Error saving data:", error);
        return res.status(500).json({ message: "Internal Server Error", error });
    }
});

app.get('/customerdetails/:customer_id/:switchgearID', async (req, res) => {
    try {
        const { customer_id, switchgearID } = req.params;
        const { cbid, taskId } = req.query;

        if (!customer_id || !switchgearID) {
            return res.status(400).json({ message: "Missing customer_id or switchgearID in query parameters." });
        }
        const Params = {
            TableName: "customer_data_table",
            KeyConditionExpression: "customer_id = :customer_id",
            ExpressionAttributeValues: {
                ":customer_id": customer_id
            }
        };

        const result = await ddb.query(Params).promise();
        let customer_data = result.Items;

        if (customer_data.length === 0) {
            return res.status(200).json({ message: "Customer not found." });
        }

        const findSwitchgearDetails = (customer_data, customer_id, switchgearID) => {
            for (const customer of customer_data) {
                if (customer.customer_id == customer_id) {
                    const matchedSwitchgear = customer.switchgears.find(sg => sg.switchgearID == switchgearID);
                    if (matchedSwitchgear) {
                        return matchedSwitchgear;
                    }
                }
            }
            return null;
        };
        let switchgearResponse = findSwitchgearDetails(customer_data, customer_id, switchgearID)

        if (!switchgearResponse) {
            return res.status(200).json({ message: "Switchgear not found." });
        }
        if (cbid || taskId) {
            const allTablesData = {};

            if (cbid) {
                function extractCBDetailsById(switchgearResponse, cbid) {
                    let resultCBDetails = [];

                    // Traverse through the data
                    switchgearResponse.configSwitchgears.forEach((switchgear) => {
                        switchgear.configswitchgears.forEach((configSwitchgear) => {
                            configSwitchgear.configuredCBs.forEach((cb) => {
                                if (cb.id == cbid) {
                                    resultCBDetails.push(cb);
                                }
                            });
                        });
                    });
                    return resultCBDetails
                }
                allTablesData.cbDetails = extractCBDetailsById(switchgearResponse, cbid);
            }
            if (taskId) {
                const resultcalconfig = []
                const resultmapconfig = []
                function calConfigurationsfun(switchgearResponse, taskId) {
                    switchgearResponse.calConfigurations.forEach((switchgear) => {
                        switchgear.switchgears.forEach((configSwitchgear) => {
                            configSwitchgear.cbs.forEach((cb) => {
                                if (cb.taskId == taskId) {
                                    resultcalconfig.push(cb);
                                }
                            });
                        });
                    });
                    return resultcalconfig.length > 0 ? resultcalconfig : `No CB found with id: ${taskId}`;
                }
                function switchgearMapppingfun(switchgearResponse, taskId) {
                    switchgearResponse.switchgearMappping.forEach((switchgear) => {
                        switchgear.switchgears.forEach((configSwitchgear) => {
                            configSwitchgear.cbs.forEach((cb) => {
                                if (cb.taskId == taskId) {
                                    resultmapconfig.push(cb);
                                }
                            });
                        });
                    });
                    return resultmapconfig.length > 0 ? resultmapconfig : `No CB found with id: ${taskId}`;
                }

                allTablesData.calConfigurations = calConfigurationsfun(switchgearResponse, taskId);
                allTablesData.switchgearMappping = switchgearMapppingfun(switchgearResponse, taskId);
            }
            return res.status(200).json({ message: "Sucesfully fetched customer details", allTablesData });
        }

        let response = {
            switchgearResponse
        }
        return res.status(200).json(response);

    } catch (error) {
        console.error("Error fetching customer details:", error);
        return res.status(500).json({ message: "Internal Server Error", error });
    }
})

const PORT = 4000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
