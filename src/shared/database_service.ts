import { Constants } from './constants';
import { Collection, Db, MongoClient, ObjectId } from "mongodb";
import { User } from '../models/user/user';
import { TimeEntrySyncedObject } from '../models/synced_service/time_entry_synced_object/time_entry_synced_object';
import { JobLog } from '../models/job_log';
import {Connection} from "../models/connection/connection";

export class DatabaseService {
  private static _mongoDbName = 'timer2ticketDB_new';
  private static _usersCollectionName = 'users';
  private static _connectionsCollectionName = 'connections';
  private static _timeEntrySyncedObjectsCollectionName = 'timeEntrySyncedObjects';
  private static _jobLogsCollectionName = 'jobLogs';

  private static _instance: DatabaseService;

  private _mongoClient: MongoClient | undefined;
  private _db: Db | undefined;

  private _usersCollection: Collection<User> | undefined;
  private _connectionsCollection: Collection<Connection> | undefined;
  private _timeEntrySyncedObjectsCollection: Collection<TimeEntrySyncedObject> | undefined;
  private _jobLogsCollection: Collection<JobLog> | undefined;

  private _initCalled = false;

  public static get Instance(): DatabaseService {
    return this._instance || (this._instance = new this());
  }

  /**
   * Private empty constructor to make sure that this is correct singleton
   */
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  private constructor() { }

  /**
   * Needs to be called (and awaited) to correctly connect to the database
   */
  public async init(): Promise<boolean> {
    if (this._initCalled) {
      return false;
    }
    this._initCalled = true;

    // Make a connection to MongoDB Service
    this._mongoClient = new MongoClient(Constants.mongoDbUrl, { useUnifiedTopology: true });

    await this._mongoClient.connect();
    console.log("Connected to MongoDB!");

    if (!this._mongoClient) return false;

    this._db = this._mongoClient.db(DatabaseService._mongoDbName);

    this._usersCollection = this._db.collection(DatabaseService._usersCollectionName);
    this._connectionsCollection = this._db.collection(DatabaseService._connectionsCollectionName);
    this._timeEntrySyncedObjectsCollection = this._db.collection(DatabaseService._timeEntrySyncedObjectsCollectionName);
    this._jobLogsCollection = this._db.collection(DatabaseService._jobLogsCollectionName);

    return true;
  }

  private _close() {
    this._mongoClient?.close();
  }

  // ***********************************************************
  // USERS *****************************************************
  // ***********************************************************

  async getUserById(userId: ObjectId): Promise<User | null> {
    if (!this._usersCollection) return null;

    const filterQuery = { _id: userId };
    return this._usersCollection.findOne(filterQuery);
  }

  // ***********************************************************
  // CONNECTIONS ***********************************************
  // ***********************************************************

  async getConnectionById(connectionId: ObjectId): Promise<Connection | null> {
    if (!this._connectionsCollection) return null;

    const filterQuery = { _id: connectionId };
    return this._connectionsCollection.findOne(filterQuery);
  }

  async getActiveConnections(): Promise<Connection[]> {
    if (!this._connectionsCollection) return [];

    const filterQuery = { isActive: true };
    return this._connectionsCollection.find(filterQuery).toArray();
  }

  async updateConnectionMappings(connection: Connection): Promise<boolean> {
    return this._updateConnectionPartly(connection, { $set: { mappings: connection.mappings } });
  }
  async updateConnectionConfigSyncJobLastDone(connection: Connection): Promise<boolean> {
    return this._updateConnectionPartly(connection, { $set: {
      "configSyncJobDefinition.lastJobTime": connection.configSyncJobDefinition.lastJobTime,
        "configSyncJobDefinition.status": connection.configSyncJobDefinition.status ,
    } });
  }

  async updateConnectionTimeEntrySyncJobLastDone(connection: Connection): Promise<boolean> {
    return this._updateConnectionPartly(connection, { $set: {
        "timeEntrySyncJobDefinition.lastJobTime": connection.timeEntrySyncJobDefinition.lastJobTime,
        "timeEntrySyncJobDefinition.status": connection.timeEntrySyncJobDefinition.status,
      } });
  }

  private async _updateConnectionPartly(connection: Connection, updateQuery: Record<string, unknown>): Promise<boolean> {
    if (!this._connectionsCollection) return false;

    const filterQuery = { _id: new ObjectId(connection._id) };

    const result = await this._connectionsCollection.updateOne(filterQuery, updateQuery);
    return result.result.ok === 1;
  }

  async getConnectionsToDelete(): Promise<Connection[]> {
    if (!this._connectionsCollection) return [];

    // remove connections with 2 days old deleteTimestamp
    const deleteTimestampFilter = new Date();
    deleteTimestampFilter.setDate(deleteTimestampFilter.getDate() - 2);

    const filterQuery = { deleteTimestamp: { $lt: deleteTimestampFilter.getTime() } };
    return this._connectionsCollection.find(filterQuery).toArray();
  }

  async cleanUpConnections(): Promise<boolean> {
    if (!this._connectionsCollection) return false;

    // remove connections with 2 days old deleteTimestamp
    const deleteTimestampFilter = new Date();
    deleteTimestampFilter.setDate(deleteTimestampFilter.getDate() - 2);

    const filterQuery = { deleteTimestamp: { $lt: deleteTimestampFilter.getTime() } };
    const result = await this._connectionsCollection.deleteMany(filterQuery);
    return result.result.ok === 1;
  }

  // ***********************************************************
  // TIME ENTRY SYNCED OBJECTS *********************************
  // ***********************************************************

  async getTimeEntrySyncedObjects(connection: Connection): Promise<TimeEntrySyncedObject[] | null> {
    if (!this._timeEntrySyncedObjectsCollection) return null;

    const filterQuery = { connectionId: new ObjectId(connection._id) };
    return this._timeEntrySyncedObjectsCollection.find(filterQuery).toArray();
  }

  async createTimeEntrySyncedObject(timeEntrySyncedObject: TimeEntrySyncedObject): Promise<TimeEntrySyncedObject | null> {
    if (!this._timeEntrySyncedObjectsCollection) return null;

    const result = await this._timeEntrySyncedObjectsCollection.insertOne(timeEntrySyncedObject);
    return result.result.ok === 1 ? result.ops[0] : null;
  }

  async updateTimeEntrySyncedObject(timeEntrySyncedObject: TimeEntrySyncedObject): Promise<TimeEntrySyncedObject | null> {
    if (!this._timeEntrySyncedObjectsCollection) return null;

    const filterQuery = { _id: new ObjectId(timeEntrySyncedObject._id) };

    const result = await this._timeEntrySyncedObjectsCollection.replaceOne(filterQuery, timeEntrySyncedObject);
    return result.result.ok === 1 ? result.ops[0] : null;
  }

  async makeTimeEntrySyncedObjectArchived(timeEntrySyncedObject: TimeEntrySyncedObject): Promise<true | null> {
    if (!this._timeEntrySyncedObjectsCollection) return null;

    let tesoId;
    if (timeEntrySyncedObject._id instanceof ObjectId) {
      tesoId = timeEntrySyncedObject._id;
      console.log('[ORM] tesoId je ObjectId s value='.concat(tesoId.toHexString()));
    } else {
      tesoId = new ObjectId(timeEntrySyncedObject._id);
      console.log('[ORM] tesoId je string s value='.concat(tesoId.toHexString()));
    }
    const filterQuery = { _id: tesoId };

    const result = await this._timeEntrySyncedObjectsCollection.updateOne(
        filterQuery,
        {
          $set: {
            "archived": true
          }
        }
    );

    console.log(
        `${result.matchedCount} document(s) matched the filter _id=${tesoId.toHexString()}, updated ${result.modifiedCount} document(s)`
    );
    return result.modifiedCount === 1 ? true : null;
  }

  async deleteTimeEntrySyncedObject(timeEntrySyncedObject: TimeEntrySyncedObject): Promise<boolean> {
    if (!this._timeEntrySyncedObjectsCollection) return false;

    const filterQuery = { _id: new ObjectId(timeEntrySyncedObject._id) };

    const result = await this._timeEntrySyncedObjectsCollection.deleteOne(filterQuery);
    return result.result.ok === 1;
  }

  async deleteTimeEntrySyncedObjectByConnection(connectionId: ObjectId) {
    if (!this._timeEntrySyncedObjectsCollection) return false;

    const filterQuery = { connectionId: connectionId };

    const result = await this._timeEntrySyncedObjectsCollection.deleteMany(filterQuery);
    return result.result.ok === 1;
  }

  async getTimeEntrySyncedObjectForArchiving(steoId: number | string, serviceName: string, userIdInput: string | ObjectId): Promise<TimeEntrySyncedObject | null>
  {
    if (!this._timeEntrySyncedObjectsCollection) return null;

    if (userIdInput instanceof String) {
      userIdInput = new ObjectId(userIdInput);
    }
    const filterQuery = { "serviceTimeEntryObjects": { $elemMatch: { "id": steoId, "service": serviceName}}, "userId": userIdInput};
    return this._timeEntrySyncedObjectsCollection.findOne(filterQuery);
  }

  // ***********************************************************
  // JOB LOGS **************************************************
  // ***********************************************************

  async getJobLogById(jobLogId: string): Promise<JobLog | null> {
    if (!this._jobLogsCollection) return null;

    const filterQuery = { _id: new ObjectId(jobLogId) };
    return this._jobLogsCollection.findOne(filterQuery);
  }

  async createJobLog(connectionId: Connection, type: string, origin: string): Promise<JobLog | null> {
    if (!this._jobLogsCollection) return null;

    const result = await this._jobLogsCollection.insertOne(new JobLog(connectionId, type, origin));
    return result.result.ok === 1 ? result.ops[0] : null;
  }

  async updateJobLog(jobLog: JobLog): Promise<JobLog | null> {
    if (!this._jobLogsCollection) return null;

    const filterQuery = { _id: new ObjectId(jobLog._id) };

    const result = await this._jobLogsCollection.replaceOne(filterQuery, jobLog);
    return result.result.ok === 1 ? result.ops[0] : null;
  }

  async cleanUpJobLogs(): Promise<boolean> {
    if (!this._jobLogsCollection) return false;

    // remove 90 days old jobLogs
    const scheduledFilter = new Date();
    scheduledFilter.setDate(scheduledFilter.getDate() - 90);

    const filterQuery = { scheduledDate: { $lt: scheduledFilter.getTime() } };
    const result = await this._jobLogsCollection.deleteMany(filterQuery);
    return result.result.ok === 1;
  }
}

export const databaseService = DatabaseService.Instance;