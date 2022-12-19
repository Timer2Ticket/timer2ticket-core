import { Constants } from './constants';
import { Collection, Db, MongoClient, ObjectId } from "mongodb";
import { User } from '../models/user';
import { TimeEntrySyncedObject } from '../models/synced_service/time_entry_synced_object/time_entry_synced_object';
import { JobLog } from '../models/jobLog';

export class DatabaseService {
  private static _mongoDbName = 'timer2ticketDB';
  private static _usersCollectionName = 'users';
  private static _timeEntrySyncedObjectsCollectionName = 'timeEntrySyncedObjects';
  private static _jobLogsCollectionName = 'jobLogs';

  private static _instance: DatabaseService;

  private _mongoClient: MongoClient | undefined;
  private _db: Db | undefined;

  private _usersCollection: Collection<User> | undefined;
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

  async getUserById(userId: string): Promise<User | null> {
    if (!this._usersCollection) return null;

    const filterQuery = { _id: new ObjectId(userId) };
    return this._usersCollection.findOne(filterQuery);
  }

  async getUserByUsername(username: string): Promise<User | null> {
    if (!this._usersCollection) return null;

    const filterQuery = { username: username };
    return this._usersCollection.findOne(filterQuery);
  }

  async getActiveUsers(): Promise<User[]> {
    if (!this._usersCollection) return [];

    const filterQuery = { status: 'active' };
    return this._usersCollection.find(filterQuery).toArray();
  }

  async updateUser(user: User): Promise<User | null> {
    if (!this._usersCollection) return null;

    const filterQuery = { _id: new ObjectId(user._id) };

    const result = await this._usersCollection.replaceOne(filterQuery, user);
    return result.result.ok === 1 ? result.ops[0] : null;
  }

  private async _updateUserPartly(user: User, updateQuery: Record<string, unknown>): Promise<boolean> {
    if (!this._usersCollection) return false;

    const filterQuery = { _id: new ObjectId(user._id) };

    const result = await this._usersCollection.updateOne(filterQuery, updateQuery);
    return result.result.ok === 1;
  }

  async updateUserMappings(user: User): Promise<boolean> {
    return this._updateUserPartly(user, { $set: { mappings: user.mappings } });
  }

  async updateUserConfigSyncJobLastSuccessfullyDone(user: User): Promise<boolean> {
    return this._updateUserPartly(user, { $set: { "configSyncJobDefinition.lastSuccessfullyDone": user.configSyncJobDefinition.lastSuccessfullyDone } });
  }

  async updateUserTimeEntrySyncJobLastSuccessfullyDone(user: User): Promise<boolean> {
    return this._updateUserPartly(user, { $set: { "timeEntrySyncJobDefinition.lastSuccessfullyDone": user.timeEntrySyncJobDefinition.lastSuccessfullyDone } });
  }

  // ***********************************************************
  // TIME ENTRY SYNCED OBJECTS *********************************
  // ***********************************************************

  async getTimeEntrySyncedObjects(user: User): Promise<TimeEntrySyncedObject[] | null> {
    if (!this._timeEntrySyncedObjectsCollection) return null;

    const filterQuery = { userId: new ObjectId(user._id) };
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

    if (timeEntrySyncedObject.archived !== undefined) {
      console.log('[DEBUG] pred replaceOne, hodnota archived je='.concat(String(timeEntrySyncedObject.archived)))
    } else {
      console.log('[DEBUG] pred replaceOne, hodnota archived je undefined!')
    }
    const result = await this._timeEntrySyncedObjectsCollection.replaceOne(filterQuery, timeEntrySyncedObject);
    return result.result.ok === 1 ? result.ops[0] : null;
  }

  async deleteTimeEntrySyncedObject(timeEntrySyncedObject: TimeEntrySyncedObject): Promise<boolean> {
    if (!this._timeEntrySyncedObjectsCollection) return false;

    const filterQuery = { _id: new ObjectId(timeEntrySyncedObject._id) };

    const result = await this._timeEntrySyncedObjectsCollection.deleteOne(filterQuery);
    return result.result.ok === 1;
  }

  // ***********************************************************
  // JOB LOGS **************************************************
  // ***********************************************************

  async createJobLog(userId: string | ObjectId, type: string, origin: string): Promise<JobLog | null> {
    if (!this._jobLogsCollection) return null;

    const result = await this._jobLogsCollection.insertOne(new JobLog(userId, type, origin));
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