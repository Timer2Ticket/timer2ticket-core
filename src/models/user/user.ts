import { ObjectId } from 'mongodb';
import {NotificationSettings} from "./notification_settings";
import {Timezone} from "tz-offset";
export class User {
  // Mongo
  _id!: ObjectId;

  // Auth0
  auth0UserId!: string;


  // User info
  email!: string | null;
  registratedDate!: Date;
  timeZone!: Timezone;
  notifiactionSettings!: NotificationSettings;

  // Connection user id
  connectionId!: number;
}
