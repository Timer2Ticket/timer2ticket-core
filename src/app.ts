import * as Sentry from '@sentry/node';
import express, { Request, Response } from 'express';
import { Queue } from 'typescript-collections';
import cron from 'node-cron';
import { ConfigSyncJob } from './jobs/config_sync_job';
import { SyncJob } from './jobs/sync_job';
import { TimeEntriesSyncJob } from './jobs/time_entries_sync_job';
import { Constants } from './shared/constants';
import { databaseService } from './shared/database_service';
import { User } from './models/user';
import {RemoveObsoleteMappingsJob} from "./jobs/remove_obsolete_mappings_job";

Sentry.init({
  dsn: Constants.sentryDsn,
  tracesSampleRate: 0.5,
});

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// queue for ConfigSyncJobs (CSJs), TimeEntriesSyncJobs (TESJs) or RemoveMappingsJob (RMJs)
const jobQueue = new Queue<SyncJob>();

// maps containing tasks to stop them if needed
// currently using when request comes from the client app (see below)
const activeUsersScheduledConfigSyncTasks = new Map<string, cron.ScheduledTask>();
const activeUsersScheduledTimeEntriesSyncTasks = new Map<string, cron.ScheduledTask>();
const activeUsersScheduledRemoveObsoleteMappingsSyncTasks = new Map<string, cron.ScheduledTask>();

// cleanUpJob - removes old projects, issues etc. - not needed for now.

// every 10 seconds check if jobQueue is not empty
cron.schedule('*/10 * * * * *', () => {
  while (!jobQueue.isEmpty()) {
    const job = jobQueue.dequeue();

    if (job) {
      databaseService.getUserById(job.userId).then(result => {
        if(result !== null) {
          Sentry.setUser({
            username: result.username,
          })
        }

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
              //console.log(' -> Job repeated and now successfully done.');
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

  const activeUsers = await databaseService.getActiveUsers();

  activeUsers.forEach(user => {
    scheduleJobs(user);
  });

  return console.log(`Server is listening on ${Constants.appPort}`);
});

// Schedule config sync job immediately
app.post('/api/schedule_config_job/:userId([a-zA-Z0-9]{24})', async (req: Request, res: Response) => {
  const userId = req.params.userId;
  const user = await databaseService.getUserById(userId);

  if (!user) {
    return res.sendStatus(404);
  }

  // schedule CSJ right now
  const jobLog = await databaseService.createJobLog(user._id, 'config', 'manual');
  if (!jobLog) {
    return res.sendStatus(503);
  }

  jobQueue.enqueue(new ConfigSyncJob(user, jobLog));

  return res.send('User\'s config sync job scheduled successfully.');
});

// Schedule time entry sync job immediately
app.post('/api/schedule_time_entries_job/:userId([a-zA-Z0-9]{24})', async (req: Request, res: Response) => {
  const userId = req.params.userId;
  const user = await databaseService.getUserById(userId);

  if (!user) {
    return res.sendStatus(404);
  }

  // schedule only if at least one configSyncJob finished
  if (!user.configSyncJobDefinition.lastSuccessfullyDone) {
    return res.sendStatus(409);
  }

  // schedule TESJ right now
  const jobLog = await databaseService.createJobLog(user._id, 'time-entries', 'manual');
  if (!jobLog) {
    return res.sendStatus(503);
  }
  jobQueue.enqueue(new TimeEntriesSyncJob(user, jobLog));

  return res.send('User\'s time entries sync job scheduled successfully.');
});

// Schedule jobs for given user
app.post('/api/start/:userId([a-zA-Z0-9]{24})', async (req: Request, res: Response) => {
  const userId = req.params.userId;
  // config probably changed
  // => stop all scheduled cron tasks
  // => get updated user from DB
  // => start jobs again

  const configTask = activeUsersScheduledConfigSyncTasks.get(userId);
  const timeEntriesTask = activeUsersScheduledTimeEntriesSyncTasks.get(userId);

  if (configTask) {
    // should address error: #20471
    // using this fix: https://github.com/node-cron/node-cron/pull/289
    configTask.stop();
    activeUsersScheduledConfigSyncTasks.delete(userId);
  }
  if (timeEntriesTask) {
    timeEntriesTask.stop();
    activeUsersScheduledTimeEntriesSyncTasks.delete(userId);
  }

  const user = await databaseService.getUserById(userId);

  if (!user) {
    return res.sendStatus(404);
  }

  // schedule CSJ right now
  const jobLog = await databaseService.createJobLog(user._id, 'config', 't2t-auto');
  if (!jobLog) {
    return res.sendStatus(503);
  }
  jobQueue.enqueue(new ConfigSyncJob(user, jobLog));
  // and schedule next CSJs, TESJs and RMJs by the user's normal schedule
  scheduleJobs(user);

  return res.send('User\'s jobs started successfully.');
});

// Stop all jobs for given user
app.post('/api/stop/:userId([a-zA-Z0-9]{24})', async (req: Request, res: Response) => {
  const userId = req.params.userId;
  // config probably changed
  // => stop all scheduled cron tasks

  const configTask = activeUsersScheduledConfigSyncTasks.get(userId);
  const timeEntriesTask = activeUsersScheduledTimeEntriesSyncTasks.get(userId);
  const removeObsoleteMappingsTask = activeUsersScheduledRemoveObsoleteMappingsSyncTasks.get(userId);

  if (!configTask && !timeEntriesTask && !removeObsoleteMappingsTask) {
    return res.status(404).send('No jobs found for this user.');
  }

  if (configTask) {
    // should address error: #20471
    // using this fix: https://github.com/node-cron/node-cron/pull/289
    configTask.stop();
    activeUsersScheduledConfigSyncTasks.delete(userId);
  }
  if (timeEntriesTask) {
    timeEntriesTask.stop();
    activeUsersScheduledTimeEntriesSyncTasks.delete(userId);
  }
  if (removeObsoleteMappingsTask) {
    removeObsoleteMappingsTask.stop();
    activeUsersScheduledRemoveObsoleteMappingsSyncTasks.delete(userId);
  }

  return res.send('User\'s jobs stopped successfully.');
});

// Returns 204 if config, TE and RM jobs are scheduled for given user
app.post('/api/scheduled/:userId([a-zA-Z0-9]{24})', async (req: Request, res: Response) => {
  const userId = req.params.userId;

  const configTask = activeUsersScheduledConfigSyncTasks.get(userId);
  const timeEntriesTask = activeUsersScheduledTimeEntriesSyncTasks.get(userId);
  const removeObsoleteMappingsTask = activeUsersScheduledRemoveObsoleteMappingsSyncTasks.get(userId);

  if (configTask && timeEntriesTask && removeObsoleteMappingsTask) {
    return res.send({ scheduled: true });
  }

  // return 200 OK if jobs are not scheduled (technically not error or something)
  return res.send({ scheduled: false });
});

function scheduleJobs(user: User) {
  // console.log(`SCHEDULE jobs for user ${user.username} with id=${user._id}`);

  // cron schedule validation can be omitted (schedule is already validated when user - and schedule too - is updated)
  if (cron.validate(user.configSyncJobDefinition.schedule)) {
    const task = cron.schedule(user.configSyncJobDefinition.schedule, async () => {
      // grab fresh user with all updated values
      const actualUser = await databaseService.getUserById(user._id.toString());
      if (actualUser) {
        const jobLog = await databaseService.createJobLog(user._id, 'config', 't2t-auto');
        if (jobLog) {
          // console.log(' -> Added ConfigSyncJob');
          jobQueue.enqueue(new ConfigSyncJob(actualUser, jobLog));
        }
      }
    });
    activeUsersScheduledConfigSyncTasks.set(user._id.toString(), task);
  }

  if (cron.validate(user.timeEntrySyncJobDefinition.schedule)) {
    const task = cron.schedule(user.timeEntrySyncJobDefinition.schedule, async () => {
      // grab fresh user from the db to see his lastSuccessfullyDone
      const actualUser = await databaseService.getUserById(user._id.toString());
      // check if not null => there was at least 1 successful config job done => basic mappings should be there
      if (actualUser?.configSyncJobDefinition.lastSuccessfullyDone) {
        const jobLog = await databaseService.createJobLog(user._id, 'time-entries', 't2t-auto');
        if (jobLog) {
          // console.log(' -> Added TESyncJob');
          jobQueue.enqueue(new TimeEntriesSyncJob(actualUser, jobLog));
        }
      }
    });
    activeUsersScheduledTimeEntriesSyncTasks.set(user._id.toString(), task);
  }

  if (cron.validate(user.removeObsoleteMappingsJobDefinition.schedule)) {
    const task = cron.schedule(user.removeObsoleteMappingsJobDefinition.schedule, async () => {
      // grab fresh user from the db to see his lastSuccessfullyDone
      const actualUser = await databaseService.getUserById(user._id.toString());
      if (actualUser) {
        const jobLog = await databaseService.createJobLog(user._id, 'remove-obsolete-mappings', 't2t-auto');
        if (jobLog) {
          // console.log(' -> Added RemoveMappingsJob');
          jobQueue.enqueue(new RemoveObsoleteMappingsJob(actualUser, jobLog));
        }
      }
    });
    activeUsersScheduledRemoveObsoleteMappingsSyncTasks.set(user._id.toString(), task);
  }
}
