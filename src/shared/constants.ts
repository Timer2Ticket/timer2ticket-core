// eslint-disable-next-line @typescript-eslint/no-var-requires
require('dotenv').config();

export class Constants {
  static appPort = 3000;

  static mongoDbUrl = process.env.MONGODB_URL || 'mongodb://localhost:27017';

  static sentryDsn = process.env.SENTRY_DSN || '';
  static daysToSync = 60;

  static defaultWaitDurationInCaseOfTooManyRequestsInMilliseconds = 1500;

  static configObjectMappingMarkedToDeleteTresholdInDays = 7;
}