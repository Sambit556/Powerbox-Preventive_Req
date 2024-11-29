const express = require('express');
const AWS = require('aws-sdk');
const bodyParser = require('body-parser');
const cors = require('cors');
const moment = require('moment'); // For date comparison

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
        await checkTableExistence(tableName);

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
        await checkTableExistence(tableName)
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
});  // work

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
    const { tasks_id, subTasks_id, updates } = req.body;
    const tableName = "Preventive_mentainance_Storage";

    if (!customerId || !tasks_id || !updates) {
        return res.status(400).json({
            error: "'customerId', 'tasks_id', and 'updates' are required.",
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

        // Locate the task and subtask to update
        const tasks = data.Item.tasks;
        const taskIndex = tasks.findIndex((task) => task.tasks_id === tasks_id);

        if (taskIndex === -1) {
            return res.status(404).json({ error: "Task not found." });
        }

        const task = tasks[taskIndex];

        // Prevent mainTask update if isCustom is false
        if (!task.isCustom && updates.mainTask) {
            return res.status(400).json({
                error: "Cannot update 'Name' for this task.",
            });
        }

        if (subTasks_id) {
            // Update a specific subtask
            const subTaskIndex = task.subTasks.findIndex(
                (subTask) => subTask.subTasks_id === subTasks_id
            );

            if (subTaskIndex === -1) {
                return res.status(404).json({ error: "Subtask not found." });
            }

            // Merge updates into the subtask
            task.subTasks[subTaskIndex] = {
                ...task.subTasks[subTaskIndex],
                ...updates,
            };
        } else {
            // Update the task itself
            tasks[taskIndex] = {
                ...task,
                ...updates,
            };
        }

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
    const { tasks_id, subTasks_id } = req.body;
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

        if (subTasks_id) {
            // Locate and delete a specific subtask
            const subTaskIndex = task.subTasks.findIndex(
                (subTask) => subTask.subTasks_id === subTasks_id
            );

            if (subTaskIndex === -1) {
                return res.status(404).json({ error: "Subtask not found." });
            }

            // Remove the subtask from the subTasks array
            task.subTasks.splice(subTaskIndex, 1);
        } else {
            // Delete the entire task
            tasks.splice(taskIndex, 1);
        }

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
            message: subTasks_id
                ? "Subtask deleted successfully."
                : "Task deleted successfully.",
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
                (sg) => sg.swiggearId === newSwitchgear.swiggearId
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
            const cbNames = matchingDevice.configuredCBs.map(cb => cb.name);
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

        const mapConfigResult = await ddb.get(mapConfigParams).promise();
        if (!mapConfigResult.Item) {
            return res.status(404).json({ message: "No data found for the given customer_id in Map_ConfigTable." });
        }

        // Search for the switchgear containing the CB
        const matchingSwitchgear = mapConfigResult.Item.switchgears.find(
            switchgear => switchgear.cbs && switchgear.cbs.some(cb => cb.cbname === cbName)
        );
        if (!matchingSwitchgear) {
            return res.status(200).json({ message: `No CB's planshudule found with name '${cbName}' in the switchgears.`, count: 0 });
        }

        let allCBsTaskID = []
        // Aggregate CB data
        const matchingCBs = matchingSwitchgear.cbs.filter(cb => cb.cbname === cbName);
        const planshudules = [...new Set(matchingCBs.map(cb => cb.planshudule))];
        const today = new Date().toISOString().split("T")[0];
        const cbCreatedTodayCount = matchingCBs.filter(cb => cb.cretionDate.startsWith(today)).length;
        matchingCBs.forEach(cb => {
            if (cb.taskId) {
                allCBsTaskID.push(cb.taskId); // Push only the taskId
            }
        });

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

app.get('/switchgear/:id/:switchgearId', async (req, res) => {
    const { id, switchgearId } = req.params;
    const { taskId } = req.query; // Extract taskId from query parameters
    const TableName = "Preventive_mappping_Storage";

    // DynamoDB params to fetch the data by customer_id
    const params = {
        TableName: TableName,
        Key: { customer_id: id },
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
                    pms_des: task.pms_des,
                    planshudule: task.planshudule,
                    fromDate: task.planstartDate,
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
                pms_des: cb.pms_des,
                planshudule: cb.planshudule,
                fromDate: cb.planstartDate,
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
    const { fromDate, toDate } = req.body;

    const allowedFields = ['fromDate', 'toDate'];
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

            if (taskToUpdate.planstartDate >= today) {
                taskToUpdate.planstartDate = fromDate;
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

app.get('/preservice/:table/:customer_id', async (req, res) => {
    const { table, customer_id } = req.params;
    const { planType, scheduleType, ...extraParams } = req.query; // Added scheduleType
    const tableName = "Preventive_mappping_Storage";
    const locationTableName = "switchgearConfig_Store"; // Table containing the location information

    if (Object.keys(extraParams).length > 0) {
        return res.status(400).json({
            error: "Unexpected query parameters",
            unexpectedParams: Object.keys(extraParams)
        });
    }

    // Validate inputs
    if (!table || !customer_id || !planType) {
        return res.status(400).json({ error: "Both 'customer_id' and 'planType' are required" });
    }

    try {
        // Fetch customer data from DynamoDB
        const params = {
            TableName: tableName,
            Key: { customer_id },
        };
        const result = await ddb.get(params).promise();

        // Check if customer exists
        if (!result.Item) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        const switchgears = result.Item.switchgears || [];
        let response = {
            customer_id,
            switchgears: [],
        };
        // const locationParams = {
        //     TableName: locationTableName,
        //     KeyConditionExpression: 'customer_id = :customer_id',
        //     ExpressionAttributeValues: {
        //         ':customer_id': customer_id,
        //     }
        // };
        // const locationResult = await ddb.query(locationParams).promise();

        // const locationMapping = {}; // Map cbname to location

        // Populate the location mapping from the location table result

        // locationResult.Items.forEach((item) => {
        //     // Iterate through the configswitchgears array within each item
        //     item.configswitchgears.forEach((switchgear) => {
        //         // Now you can access each switchgear and its properties
        //         // If you want to iterate over configuredCBs inside each switchgear
        //         switchgear.configuredCBs.forEach((cb) => {
        //             // Access each CB here
        //             console.log(cb.location);
        //         });
        //     });
        // });
        // locationResult.Items.forEach() => {

        //     locationMapping[item.name] = item.location; // Assuming 'name' is cbname and 'location' is the location
        // });
        // Process each switchgear
        switchgears.forEach((switchgear) => {
            const cbs = switchgear.cbs || [];

            let filteredCbs;

            if (planType === 'Individual' && scheduleType) {
                // Filter CBs based on the schedule type
                filteredCbs = cbs
                    .filter((cb) => cb.planshudule === scheduleType)
                    .map((cb) => ({
                        cbname: cb.cbname,
                        pms_des: cb.pms_des,
                        planshudule: cb.planshudule,
                        cretionDate: cb.creationDate,
                        planEndDate: cb.planEndDate,
                        taskId: cb.taskId,
                        planstartDate: cb.planstartDate,
                    }));
            } else if (planType === 'Totalplan' || planType === 'Individual') {
                // Keep all CBs for Totalplan                
                filteredCbs = cbs.map((cb) => ({
                    cbname: cb.cbname,
                    pms_des: cb.pms_des,
                    planshudule: cb.planshudule,
                    cretionDate: cb.creationDate,
                    planEndDate: cb.planEndDate,
                    taskId: cb.taskId,
                    planstartDate: cb.planstartDate,
                    totalPlan: calculateDays(cb.planEndDate, cb.planstartDate),
                    completePlan: calculateDays(new Date().toISOString().split('T')[0], cb.planstartDate),
                    pendingPlan: calculateDays(cb.planEndDate, new Date().toISOString().split('T')[0]),
                    // location: locationMapping[cb.name] || 'Unknown', // Fetch location for each cb
                    location: 'Unknown', // Fetch location for each cb
                }));
            } else {
                filteredCbs = [];
            }

            if (filteredCbs.length > 0) {
                response.switchgears.push({
                    switchgearId: switchgear.switchgearId,
                    cbs: filteredCbs,
                });
            }
        });

        // Return the response
        return res.status(200).json(response);
    } catch (err) {
        console.error("Error:", err);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Helper function to calculate the difference in days
function calculateDays(date1, date2) {
    const d1 = new Date(date1);
    const d2 = new Date(date2);
    const diffInMs = d1 - d2;
    return Math.ceil(diffInMs / (1000 * 60 * 60 * 24));
}



const PORT = 4000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
