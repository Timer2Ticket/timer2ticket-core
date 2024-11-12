import { Mapping } from "../models/mapping/mapping";
import { MappingsObject } from "../models/mapping/mappings_object";
import { ServiceObject } from "../models/synced_service/service_object/service_object";
import { TimeEntry } from "../models/synced_service/time_entry/time_entry";
import {User} from "../models/user";
import {Timer2TicketError} from "../models/timer2TicketError";
import {SentryService} from "../shared/sentry_service";
import {ErrorService} from "../shared/error_service";
import {ServiceTimeEntryObject} from "../models/synced_service/time_entry_synced_object/service_time_entry_object";

export interface SyncedService {

  errors: Array<Timer2TicketError>;
  readonly _sentryService: SentryService
  readonly _errorService: ErrorService
  readonly _user: User | null
  //This controls if service allows backward tag assignment as source or target.
  // This means that for now if a TE comes from Toggl it is allowed to sync even without mappings. But it can only sync to
  // RM. So toggl is the source, RM is the target
  readonly supportsBackwardTagAssignmentAsSource: boolean
  readonly supportsBackwardTagAssignmentAsTarget: boolean

  // TODO should return optional object wrapping ServiceObject[]
  /**
   * Get all service objects which: projects, issues, activities etc.
   * returns false in case of error
   * @param lastSyncAt Date (timestamp) from which to fetch service objects.
   */
  getAllServiceObjects(lastSyncAt: number | null): Promise<ServiceObject[] | boolean>;

  /**
   * Create service object like project, issue, tag and activity in the service, and return newly created one
   *
   * Typically created with name '[objectName] ([objectType])' or '#[objectId] [objectName] ([objectType])'
   * @param objectId id of serviceObject in the primary service => needed to generate name with that id
   * @param objectName name of serviceObject
   * @param objectType type of serviceObject, ('tag', ...)
   */
  createServiceObject(objectId: string | number, objectName: string, objectType: string): Promise<ServiceObject>;

  /**
   * Update service object like project, issue, tag and activity in the service, and return updated one
   * Used generally to update the object's name
   * Typically with name '[objectName] ([objectType])'
   * @param objectId id of object to update
   * @param serviceObject serviceObject based on real object in primary service to extract name and possibly type for
   */
  updateServiceObject(objectId: string | number, serviceObject: ServiceObject): Promise<ServiceObject>;

  deleteServiceObject(id: string | number, objectType: string): Promise<boolean>;

  /**
   * Generates full name for given service object (Toggl, for example, generates names for tags as 'name (type)' or if issue, then '#id name (type)')
   * @param serviceObject
   */
  getFullNameForServiceObject(serviceObject: ServiceObject): string;

  /**
   * getTimeEntries
   */
  getTimeEntries(start?: Date, end?: Date): Promise<TimeEntry[]>;

  /**
   * Returns only one time entry based on given id
   */
  getTimeEntryById(id: number | string, start?: Date): Promise<TimeEntry | null>;

  /**
   * Create a new time entry real object in the service, returns specific TimeEntry
   * @param durationInMilliseconds
   * @param start
   * @param end
   * @param text
   * @param additionalData
   */
  createTimeEntry(durationInMilliseconds: number, start: Date, end: Date, text: string, additionalData: ServiceObject[]): Promise<TimeEntry | null>;

  replaceTimeEntryDescription(toggleTimeEntry: ServiceTimeEntryObject, tagName: number | string): Promise<void>

  /**
   * Delete time entry with given id, returns true if successfully deleted
   * @param id of the time entry to delete from the service
   */
  deleteTimeEntry(id: string | number): Promise<boolean>;

  /**
   * Extracts objects from specific timeEntry, e.g. toggl extracts projectId from projectId, issue and time entry activity from TE's tags
   * @param timeEntry timeEntry object from which mappingsObjects are extracting - each specific manager has its specific time entry instance (e.g. TogglTimeEntry)
   * @param mappings user's mappings where to find mappingsObjects (by id)
   */
  extractMappingsObjectsFromTimeEntry(timeEntry: TimeEntry, mappings: Mapping[]): MappingsObject[];

  getTimeEntriesRelatedToMappingObjectForUser(mapping: Mapping, user: User): Promise<TimeEntry[] | null>;

  updateTimeEntry(durationInMilliseconds: number, start: Date, text: string, additionalData: ServiceObject[], originalTimeEntry: TimeEntry): Promise<TimeEntry>;
}