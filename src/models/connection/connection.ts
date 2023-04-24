import { ObjectId } from 'mongodb';
import {Mapping} from "./mapping/mapping";
import {SyncJobDefinition} from "./config/sync_job_definition";
import {SyncedServiceDefinition} from "./config/synced_service_definition";

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
  firstService!: SyncedServiceDefinition;
  secondService!: SyncedServiceDefinition;
  isActive!: boolean;
  deleteTimestamp!: number | null;
  createdTimestamp!: number;
  mappings!: Mapping[];

  static getConnectionBetweenString(connection: Connection): string {
    return `${SyncedServiceDefinition.getSyncServiceName(connection.firstService)} - ${SyncedServiceDefinition.getSyncServiceName(connection.secondService)}`;
  }

  static findServiceDefinitionByName(serviceName: string, connection: Connection): SyncedServiceDefinition | undefined {
    if (connection.firstService.name === serviceName) {
      return connection.firstService;
    } else if (connection.secondService.name === serviceName) {
      return connection.secondService;
    } else {
      return undefined;
    }
  }

  static getPrimaryServiceDefinition(connection: Connection): SyncedServiceDefinition | undefined {
    if (connection.firstService.name === 'Redmine') {
      return connection.firstService;
    } else if (connection.secondService.name === 'Redmine') {
      return connection.secondService;
    } else {
      return undefined;
    }
  }

  static getSecondaryServiceDefinition(connection: Connection): SyncedServiceDefinition {
    if (connection.firstService.name !== 'Redmine') {
      return connection.firstService;
    } else if (connection.secondService.name !== 'Redmine') {
      return connection.secondService;
    } else {
      throw "Cannot occur because two same services cannot be connected"
    }
  }
}