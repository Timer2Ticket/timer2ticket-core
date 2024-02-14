// eslint-disable-next-line @typescript-eslint/no-var-requires
require('dotenv').config();

export class Constants {
  static appPort = 3000;

  static mongoDbName = process.env.DB_NAME || 'timer2ticketDB_new';

  static mongoDbUrl = process.env.MONGODB_URL || 'mongodb://localhost:27017';

  static sentryDsn = process.env.SENTRY_DSN || 'https://d9e4e19c9f15821d57796be76000be61@o4506110897750016.ingest.sentry.io/4506110899781632';
  static daysToSync = 60;

  static defaultWaitDurationInCaseOfTooManyRequestsInMilliseconds = 1500;

  static configObjectMappingMarkedToDeleteTresholdInDays = 1;
}