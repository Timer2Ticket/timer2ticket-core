import * as Sentry from '@sentry/node';
import express, { Request, Response } from 'express';
import { Queue } from 'typescript-collections';
import cron from 'node-cron';
import { ConfigSyncJob } from './jobs/config_sync_job';
import { SyncJob } from './jobs/sync_job';
import { TimeEntriesSyncJob } from './jobs/time_entries_sync_job';
import { Constants } from './shared/constants';
import { databaseService } from './shared/database_service';
import { Connection } from "./models/connection/connection";
import { ObjectId } from "mongodb";
import { JiraTimeEntry } from './models/synced_service/time_entry/jira_time_entry';
import { ServiceObject } from './models/synced_service/service_object/service_object';
import { WebhookHandler } from './webhooks/webhook_handler';
import { WebhookEventData } from './models/connection/config/webhook_event_data';

Sentry.init({
    dsn: Constants.sentryDsn,
    tracesSampleRate: 1.0
});

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// queue for ConfigSyncJobs (CSJs) or TimeEntriesSyncJobs (TESJs)
const jobQueue = new Queue<SyncJob>();

// maps containing tasks to stop them if needed
// currently using when request comes from the client app (see below)
const activeUsersScheduledConfigSyncTasks = new Map<string, cron.ScheduledTask>();
const activeUsersScheduledTimeEntriesSyncTasks = new Map<string, cron.ScheduledTask>();

// cleanUpJob - removes old projects, issues etc. - not needed for now.

// every 10 seconds check if jobQueue is not empty
cron.schedule('*/10 * * * * *', () => {
    while (!jobQueue.isEmpty()) {
        const job = jobQueue.dequeue();

        if (job) {
            Sentry.setUser({
                username: job.userId,
            })
            // console.log(' -> Do the job');
            try {
                job.start().then(res => {
                    if (res) {
                        // console.log(' -> Job successfully done.');
                        return;
                    }

                    // not successful, try to repeat it
                    // console.log(' -> Repeating job');
                    job.start().then(resRepeated => {
                        if (resRepeated) {
                            // console.log(' -> Job repeated and now successfully done.');
                            return;
                        }

                        // console.log(' -> Job unsuccessful.');
                        // Sentry.captureMessage(`Job unsuccessful for user: ${job.userId}`);
                    });
                });
            } catch (ex) {
                Sentry.captureException(ex);
            }
        }
    }
});

// App init
app.listen(Constants.appPort, async () => {
    await databaseService.init();

    // schedule once a month jobLogs cleanUp job
    databaseService.cleanUpJobLogs();
    cron.schedule('0 3 3 */1 *', async () => {
        const sentryTransaction = Sentry.startTransaction({
            op: 'clean-up-job-logs',
            name: 'Clean up job logs transaction',
        });
        const res = await databaseService.cleanUpJobLogs();
        if (!res) {
            Sentry.captureMessage('Job logs clean up unsuccessful.');
        }
        sentryTransaction.finish();
    });

    // schedule once a month connection cleanUp job
    databaseService.cleanUpConnections();
    cron.schedule('0 3 3 */1 *', async () => {
        const sentryTransaction = Sentry.startTransaction({
            op: 'clean-up-connections',
            name: 'Clean up connections transaction',
        });
        let res = true;

        const connectionsToDelete = await databaseService.getConnectionsToDelete();
        for (const connection of connectionsToDelete) {
            res = res && await databaseService.deleteTimeEntrySyncedObjectByConnection(connection._id);
        }

        const cleanUpConnectionsResult = await databaseService.cleanUpConnections();
        if (!cleanUpConnectionsResult) {
            res = false;
        }
        if (!res) {
            Sentry.captureMessage('Job logs clean up unsuccessful.');
        }
        sentryTransaction.finish();
    });

    const connections = await databaseService.getActiveConnections();

    connections.forEach(connection => {
        scheduleJobs(connection);
    });

    return console.log(`Server is listening on ${Constants.appPort}`);
});

// Schedule config sync job immediately
app.post('/api/v2/schedule_config_job/:jobLogId([a-zA-Z0-9]{24})', async (req: Request, res: Response) => {
    const jobLogId = req.params.jobLogId;
    const jobLog = await databaseService.getJobLogById(jobLogId);

    if (!jobLog) {
        return res.sendStatus(404);
    }

    const connection = await databaseService.getConnectionById(jobLog.connectionId);
    if (!connection) {
        return res.sendStatus(404);
    }

    const user = await databaseService.getUserById(connection.userId);
    if (!user) {
        return res.sendStatus(404);
    }

    jobQueue.enqueue(new ConfigSyncJob(user, connection, jobLog));

    return res.send('User\'s config sync job scheduled successfully.');
});

// Schedule time entry sync job immediately
app.post('/api/v2/schedule_time_entries_job/:jobLogId([a-zA-Z0-9]{24})', async (req: Request, res: Response) => {
    const jobLogId = req.params.jobLogId;
    const jobLog = await databaseService.getJobLogById(jobLogId);

    if (!jobLog) {
        return res.sendStatus(404);
    }

    const connection = await databaseService.getConnectionById(jobLog.connectionId);
    if (!connection) {
        return res.sendStatus(404);
    }

    const user = await databaseService.getUserById(connection.userId);
    if (!user) {
        return res.sendStatus(404);
    }

    jobQueue.enqueue(new TimeEntriesSyncJob(user, connection, jobLog));

    return res.send('User\'s time entries sync job scheduled successfully.');
});

// Schedule jobs for connection
app.post('/api/v2/create/:connectionId([a-zA-Z0-9]{24})', async (req: Request, res: Response) => { //    ([a-zA-Z0-9]{24})
    const connectionId = req.params.connectionId;
    const responseCode = await updateConnection(connectionId, true);
    if (responseCode === null) {
        return res.sendStatus(201);
    }
    return res.sendStatus(responseCode);

});

// Schedule jobs for connections
app.post('/api/v2/update/', async (req: Request, res: Response) => {
    const connectionIds = req.body.connectionIds;
    // config probably changed
    // => stop all scheduled cron tasks
    // => get updated user from DB
    // => start jobs again

    const unsuccesfulConnectionIds = [];
    for (const connectionId of connectionIds) {
        const responseCode = await updateConnection(connectionId, false);
        if (responseCode !== null) {
            unsuccesfulConnectionIds.push(connectionId);
        }
    }

    if (unsuccesfulConnectionIds.length > 0) {
        return res.status(400).send(`Failed to update connections: ${unsuccesfulConnectionIds.join(', ')}`);

    } else {
        return res.send('Connections updated successfully.');
    }
});

app.post('/api/v2/webhooks', async (req: Request, res: Response) => {
    res.sendStatus(200)
    let webhookEventData
    try {
        webhookEventData = new WebhookEventData(req.body.type, req.body.id, req.body.event, req.body.timestamp, new ObjectId(req.body.connectionId), req.body.serviceNumber)
    } catch (err: any) {
        return
    }
    const connection = await databaseService.getConnectionById(webhookEventData.connectionId)
    if (!connection)
        return
    const webhookHandler = new WebhookHandler(webhookEventData, connection)
    await webhookHandler.handleWebhook()
})



async function updateConnection(connectionId: string, isCreated: boolean): Promise<number | null> {
    const configTask = activeUsersScheduledConfigSyncTasks.get(connectionId);
    const timeEntriesTask = activeUsersScheduledTimeEntriesSyncTasks.get(connectionId);
    let connectionObjectId;
    try {
        connectionObjectId = new ObjectId(connectionId);
    } catch (ex) {
        return 404;
    }

    if (configTask) {
        // should address error: #20471
        // using this fix: https://github.com/node-cron/node-cron/pull/289
        configTask.stop();
        activeUsersScheduledConfigSyncTasks.delete(connectionId);
    }
    if (timeEntriesTask) {
        timeEntriesTask.stop();
        activeUsersScheduledTimeEntriesSyncTasks.delete(connectionId);
    }

    const connection = await databaseService.getConnectionById(connectionObjectId);
    if (!connection) {
        return 404;
    }

    const user = await databaseService.getUserById(connection.userId);
    if (!user) {
        return 404;
    }


    if (connection.isActive && isCreated) {
        // schedule CSJ right now
        const jobLog = await databaseService.createJobLog(connection, 'config', 't2t-auto');
        if (!jobLog) {
            return 503;
        }
        jobQueue.enqueue(new ConfigSyncJob(user, connection, jobLog));
    }

    // and schedule next CSJs and TESJs by the user's normal schedule
    if (connection.isActive) {
        scheduleJobs(connection);
    }

    return null;
}

async function scheduleJobs(connection: Connection) {
    // console.log(`SCHEDULE jobs for user ${user.username} with id=${user._id}`);
    const actualUser = await databaseService.getUserById(connection.userId);
    if (!actualUser) {
        return;
    }

    // cron schedule validation can be omitted (schedule is already validated when user - and schedule too - is updated)
    if (cron.validate(connection.configSyncJobDefinition.schedule)) {
        const task = cron.schedule(
            connection.configSyncJobDefinition.schedule,
            async () => {
                // grab fresh user with all updated values
                const actualConnection = await databaseService.getConnectionById(connection._id);
                if (actualConnection) {
                    const jobLog = await databaseService.createJobLog(actualConnection, 'config', 't2t-auto');
                    if (jobLog) {
                        // console.log(' -> Added ConfigSyncJob');
                        jobQueue.enqueue(new ConfigSyncJob(actualUser, connection, jobLog));
                    }
                }
            }, {
            timezone: actualUser.timeZone,
        }
        );
        activeUsersScheduledConfigSyncTasks.set(connection._id.toString(), task);
    }

    if (cron.validate(connection.timeEntrySyncJobDefinition.schedule)) {
        const task = cron.schedule(
            connection.timeEntrySyncJobDefinition.schedule,
            async () => {
                // grab fresh user with all updated values
                const actualConnection = await databaseService.getConnectionById(connection._id);
                if (actualConnection) {
                    const jobLog = await databaseService.createJobLog(actualConnection, 'time-entries', 't2t-auto');
                    if (jobLog) {
                        // console.log(' -> Added ConfigSyncJob');
                        jobQueue.enqueue(new TimeEntriesSyncJob(actualUser, connection, jobLog));
                    }
                }
            }, {
            timezone: actualUser.timeZone,
        }
        );
        activeUsersScheduledTimeEntriesSyncTasks.set(connection._id.toString(), task);
    }
}