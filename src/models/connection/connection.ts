import { ObjectId } from 'mongodb';
import {Mapping} from "./mapping/mapping";
import {SyncJobDefinition} from "./config/sync_job_definition";
import {SyncedService} from "./config/synced_service";

export class Connection {
  // Mongo
  _id!: ObjectId;

  // user connnection id
  userConnectionId!: number;

  // Link to user
  userId!: ObjectId;

  // Connection info
  configSyncJobDefinition!: SyncJobDefinition;
  timeEntrySyncJobDefinition!: SyncJobDefinition;
  firstService!: SyncedService;
  secondService!: SyncedService;
  isActive!: boolean;
  deleteTimestamp!: number | null;
  createdTimestamp!: number;
  mappings!: Mapping[];
}