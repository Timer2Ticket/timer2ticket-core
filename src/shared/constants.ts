export class Constants {
  static appPort = 3000;

  static mongoDbUrl = process.env.MONGODB_URL || 'mongodb://localhost:27017';

  static sentryDsn = process.env.SENTRY_DSN || '';

  static defaultWaitDurationInCaseOfTooManyRequestsInMilliseconds = 1500;
}