import { ServiceDefinition } from "../models/service_definition/service_definition";
import { TimeEntry } from "../models/synced_service/time_entry/time_entry";
import { SyncedServiceCreator } from "../synced_services/synced_service_creator";
import { SyncJob } from "./sync_job";
import { databaseService } from '../shared/database_service';
import { TimeEntrySyncedObject } from "../models/synced_service/time_entry_synced_object/time_entry_synced_object";
import { ServiceTimeEntryObject } from "../models/synced_service/time_entry_synced_object/service_time_entry_object";
import { SyncedService } from "../synced_services/synced_service";
import { ServiceObject } from "../models/synced_service/service_object/service_object";
import { MappingsObject } from "../models/mapping/mappings_object";
import { Utilities } from "../shared/utilities";
import {captureException} from "@sentry/node";
import * as Sentry from "@sentry/node";
import {JobLog} from "../models/job_log";
import {Timer2TicketError} from "../models/timer2TicketError";
import superagent from "superagent";
import { Constants } from "../shared/constants";

export class TimeEntriesSyncJob extends SyncJob {
  /**
   * This job takes all unsynced time entries from services and synces them across all other services
   * Synces time entries, that are identified with the user's mappings
   */

  private needsConfigJob = false;
  private _serviceTimeEntriesWrappers: ServiceTimeEntriesWrapper[] = [];

  protected async _doTheJob(): Promise<boolean> {
    let now = new Date();
    const someDaysAgoFilter = new Date(now.setDate(now.getDate() - this._user.config.daysToSync));
    now = new Date();

    const start = Utilities.compare(this._user.registrated, someDaysAgoFilter) > 0
      ? this._user.registrated
      : someDaysAgoFilter;
    // const start = this._user.registrated;
    // start of the day
    start.setHours(0);
    start.setMinutes(0);

    let operationsOk = true;

    // Need to load all time entries (TE) for each service
    // Try to find time entry in timeEntrySyncedObjects (TESOs) from DB
    // Scenarios:
    // a) TESO for given TE is not there
    //    => sync to all other services and then create new TESO
    // b) TESO is there for all services (all serviceTimeEntryObjects (STEOs) are in the TESO)
    //    => check if in any of those services does not contain updated TE (take the most recent)
    //    1) => if yes, then update in all other services and update TESO's lastUpdated
    //    2) => if no, it is synced - do nothing
    // c) TESO is there, but for some services is missing (STEOs are incomplete)
    //    => check if not somewhere updated like b), then update, otherwise do not
    //    => then sync with missing services and create new STEOs for TESO and update TESO's lastUpdated + create new TE
    // d) TESO is there, but TE is missing in the origin service (probably deleted on purpose)
    //    => delete from other services and delete TESO
    // e) TESO is there, but TE is missing in the non origin service
    //    => create new TE for the service

    // object wrapper for service and its timeEntries
    this._serviceTimeEntriesWrappers = [];
    const serviceTimeEntriesWrappersMap: Map<string, ServiceTimeEntriesWrapper> = new Map();

    // for each service definition, request time entries and then for each other service definition, sync them
    for (const serviceDefinition of this._user.serviceDefinitions) {
      const syncedService = SyncedServiceCreator.create(serviceDefinition);
      try {
        const serviceTimeEntriesWrapper = new ServiceTimeEntriesWrapper(
            serviceDefinition,
            syncedService,
            await syncedService.getTimeEntries(start, now),
        );

        this._serviceTimeEntriesWrappers.push(serviceTimeEntriesWrapper);
        serviceTimeEntriesWrappersMap.set(serviceDefinition.name, serviceTimeEntriesWrapper);
      } catch (err: any) {

        await this.updateJobLog(syncedService.errors);
        return false;
      }
    }

    const timeEntrySyncedObjectWrappers: TimeEntrySyncedObjectWrapper[] = [];

    // get all TESOs from DB for user
    const timeEntrySyncedObjects = await databaseService.getTimeEntrySyncedObjects(this._user);

    if (!timeEntrySyncedObjects) return false;

    for (const timeEntrySyncedObject of timeEntrySyncedObjects) {
      const timeEntrySyncedObjectWrapper = new TimeEntrySyncedObjectWrapper(timeEntrySyncedObject);

      for (const serviceTimeEntryObject of timeEntrySyncedObject.serviceTimeEntryObjects) {
        const serviceTimeEntryObjectWrapper = new ServiceTimeEntryObjectWrapper(serviceTimeEntryObject);

        const serviceTimeEntriesWrapper = serviceTimeEntriesWrappersMap.get(serviceTimeEntryObject.service);

        if (serviceTimeEntriesWrapper) {
          serviceTimeEntryObjectWrapper.serviceDefinition = serviceTimeEntriesWrapper.serviceDefinition;
          serviceTimeEntryObjectWrapper.syncedService = serviceTimeEntriesWrapper.syncedService;
          serviceTimeEntryObjectWrapper.timeEntry = serviceTimeEntriesWrapper.timeEntries.find(te => te.id === serviceTimeEntryObject.id);
          // for those serviceTimeEntryObjectWrapper that .find() above returned undefined => serviceTimeEntryObject exists, but TE does not => scenario d) and e)

          timeEntrySyncedObjectWrapper.serviceTimeEntryObjectWrappers.push(serviceTimeEntryObjectWrapper);
        }
      }

      timeEntrySyncedObjectWrappers.push(timeEntrySyncedObjectWrapper);
    }

    // find timeEntries that do not have its timeEntrySyncedObject => scenario a)
    // need to loop all timeEntries and try to find its TESO wrapper in timeEntrySyncedObjectWrappers
    for (const serviceTimeEntriesWrapper of this._serviceTimeEntriesWrappers) {
      for (const timeEntry of serviceTimeEntriesWrapper.timeEntries) {
        let timeEntrySyncedObjectFound = false;
        for (const timeEntrySyncedObjectWrapper of timeEntrySyncedObjectWrappers) {
          for (const serviceTimeEntryObjectWrapper of timeEntrySyncedObjectWrapper.serviceTimeEntryObjectWrappers) {
            if (serviceTimeEntryObjectWrapper.timeEntry
              && serviceTimeEntryObjectWrapper.timeEntry.id === timeEntry.id
              && serviceTimeEntryObjectWrapper.serviceDefinition.name === serviceTimeEntriesWrapper.serviceDefinition.name) {
              // found
              timeEntrySyncedObjectFound = true;
            }
          }
        }

        if (timeEntrySyncedObjectFound === false) {
          // TESO does not exist => scenario a)

          // prepare serviceTimeEntriesWrappers that are different from real TE's service wrapper
          const otherServiceTimeEntriesWrappers = this._serviceTimeEntriesWrappers
            .filter(stew => stew.serviceDefinition.name !== serviceTimeEntriesWrapper.serviceDefinition.name);

          try {
            const newTimeEntrySyncedObject = await this._createTimeEntrySyncedObject(serviceTimeEntriesWrapper, otherServiceTimeEntriesWrappers, timeEntry);
            // if defined and not null => create TESO
            if (newTimeEntrySyncedObject) {
              // no need to await DB changes
              databaseService.createTimeEntrySyncedObject(newTimeEntrySyncedObject);
            } else if (newTimeEntrySyncedObject === undefined) {
              // if undefined => error
              operationsOk = false;
              captureException("TESyncJob: a); undefined - database sync failed");
              // console.error('err: TESyncJob: a); undefined');
            }
          } catch (ex) {
            operationsOk = false;
            // Sentry.captureException(ex);
            // console.error('err: TESyncJob: a); exception');
          }
          // if null, TE is not meant to be synced
        }
      }
    }

    // other scenarios b), c), d), e)
    for (const timeEntrySyncedObjectWrapper of timeEntrySyncedObjectWrappers) {
      if (!this._isTimeEntrySyncedObjectArchived(timeEntrySyncedObjectWrapper)) {
        try {
          if (await this._checkTimeEntrySyncedObject(timeEntrySyncedObjectWrapper, someDaysAgoFilter)) {
            // some changes probably were made to TESO object, update it in db
            const dbUpdateResult = await databaseService.updateTimeEntrySyncedObject(timeEntrySyncedObjectWrapper.timeEntrySyncedObject) !== null;
            operationsOk &&= dbUpdateResult;
            if (!dbUpdateResult) {
              const scope = new Sentry.Scope();
              scope.setContext("synced object", JSON.parse(JSON.stringify(timeEntrySyncedObjectWrapper.timeEntrySyncedObject)))
              Sentry.captureException("Failed to update database");
              // console.error('err: TESyncJob: b), c), d), e); DB update');
            }
          }
        } catch (ex) {
          operationsOk = false;
          // captureException(ex);
          //console.error(ex);
          // console.error('err: TESyncJob: b), c), d), e); exception');
        }
      }
    }

    if (this.needsConfigJob) {
      await superagent.post(`http://localhost:${Constants.appPort}/api/schedule_config_job/${this._user?._id}`);
    }

    if (operationsOk) {
      this._user.timeEntrySyncJobDefinition.lastSuccessfullyDone = new Date().getTime();
      databaseService.updateUserTimeEntrySyncJobLastSuccessfullyDone(this._user);
    }

    await this.updateJobLog(this._serviceTimeEntriesWrappers.map(wrapper => wrapper.syncedService?.errors ?? []).flat())

    return operationsOk;
  }

  /**
   * Creates TESO based on given TE in other services
   * @param timeEntryOriginServiceWrapper
   * @param otherServiceTimeEntriesWrappers
   * @param timeEntry
   * @returns updated TESO OR null if not meant to be synced OR undefined if error
   */
  private async _createTimeEntrySyncedObject(
    timeEntryOriginServiceWrapper: ServiceTimeEntriesWrapper,
    otherServiceTimeEntriesWrappers: ServiceTimeEntriesWrapper[],
    timeEntry: TimeEntry)
    : Promise<TimeEntrySyncedObject | undefined | null> {
    const newTimeEntrySyncedObjectResult = new TimeEntrySyncedObject(this._user._id, timeEntry.start);

    // firstly, push origin service (from which time entry came from)
    newTimeEntrySyncedObjectResult.serviceTimeEntryObjects.push(
      new ServiceTimeEntryObject(timeEntry.id, timeEntryOriginServiceWrapper.serviceDefinition.name, true)
    );

    const otherServicesMappingsObjects = timeEntryOriginServiceWrapper.syncedService.extractMappingsObjectsFromTimeEntry(timeEntry, this._user.mappings);

    //only allows TE from toggl to pass without mapping (toggl -> rm can get issue ID from description)
    if (otherServicesMappingsObjects.length === 0 && !timeEntryOriginServiceWrapper.syncedService.supportsBackwardTagAssignmentAsSource) {
      // TE sync is not required (e.g. not project selected etc.)
      return null;
    }

    for (const otherServiceDefinition of otherServiceTimeEntriesWrappers) {

      //if not syncing to RM then skip if mappings aren't present.
      if (otherServicesMappingsObjects.length === 0 && !otherServiceDefinition.syncedService.supportsBackwardTagAssignmentAsTarget) {
        // TE sync is not required (e.g. not project selected etc.)
        continue;
      }

      const createdTimeEntry = await this._createTimeEntryBasedOnTimeEntryModel(
        otherServicesMappingsObjects,
        otherServiceDefinition.syncedService,
        timeEntry,
        newTimeEntrySyncedObjectResult,
      );

      if (!createdTimeEntry) {
        // TE not created, could be the case when no project was selected and TE is not meant to sync
        // if problem with HTTP request (returned 4xx or something else), it would fall to exception (and job will be retried)
        return null;
      }
    }

    if (newTimeEntrySyncedObjectResult.serviceTimeEntryObjects.length <= 1) {
      // means only that from origin was added, seems like an error
      return undefined;
    }

    // console.log(newTimeEntrySyncedObjectResult);
    return newTimeEntrySyncedObjectResult;
  }


  /**
   * Returns true if timeEntrySyncedObjectWrapper.TESO needs to be updated in the DB
   * @param timeEntrySyncedObjectWrapper
   * @param someDaysAgoFilter
   */
  private async _checkTimeEntrySyncedObject(
    timeEntrySyncedObjectWrapper: TimeEntrySyncedObjectWrapper,
    someDaysAgoFilter: Date)
    : Promise<boolean> {
    // firstly, find origin service
    // if TE defined => loop through all other TEs and find the last updated one,
    //    if timeEntrySyncedObjectWrapper.lastUpdated is same as that one => scenario b2) otherwise b1)
    // also, if TE missing, but STEO is there for given TE, scenario e)
    // also, if there is missing STEO for some service => scenario c)
    // if undefined (real TE is missing) => delete from all other services and delete TESO from DB - scenario d)
    const originServiceTimeEntryObjectWrapper = timeEntrySyncedObjectWrapper.serviceTimeEntryObjectWrappers.find(steow => steow.serviceTimeEntryObject.isOrigin);

    // it would be weird if this would happen
    if (!originServiceTimeEntryObjectWrapper) return false;

    // create start (since) for TE fetching
    const start = new Date(someDaysAgoFilter);
    start.setDate(start.getDate() - this._user.config.daysToSync); // look even more in the history

    if (originServiceTimeEntryObjectWrapper.timeEntry) {
      // find last updated time entry among all time entries
      let lastUpdatedServiceTimeEntryObjectWrapper = originServiceTimeEntryObjectWrapper;
      for (const serviceTimeEntryObjectWrapper of timeEntrySyncedObjectWrapper.serviceTimeEntryObjectWrappers) {
        if (!serviceTimeEntryObjectWrapper.timeEntry) {
          // fetch time entry (could be in the history)
          const fetchedTimeEntry = await serviceTimeEntryObjectWrapper.syncedService.getTimeEntryById(serviceTimeEntryObjectWrapper.serviceTimeEntryObject.id, start);
          serviceTimeEntryObjectWrapper.timeEntry = fetchedTimeEntry ?? undefined;
        }

        if (serviceTimeEntryObjectWrapper.timeEntry && lastUpdatedServiceTimeEntryObjectWrapper.timeEntry
          && new Date(serviceTimeEntryObjectWrapper.timeEntry.lastUpdated).getTime() > new Date(lastUpdatedServiceTimeEntryObjectWrapper.timeEntry.lastUpdated).getTime()) {
          lastUpdatedServiceTimeEntryObjectWrapper = serviceTimeEntryObjectWrapper;
        }
      }

      // this kind of makes no sense, but it needs to be here for unexpected weird events (and for linter)
      if (!lastUpdatedServiceTimeEntryObjectWrapper.timeEntry) return false;

      const otherServicesMappingsObjects = lastUpdatedServiceTimeEntryObjectWrapper.syncedService
        .extractMappingsObjectsFromTimeEntry(lastUpdatedServiceTimeEntryObjectWrapper.timeEntry, this._user.mappings);

      if (timeEntrySyncedObjectWrapper.timeEntrySyncedObject.lastUpdated < new Date(lastUpdatedServiceTimeEntryObjectWrapper.timeEntry.lastUpdated).getTime()) {
        // scenario b1) + possibly c) or e)
        // somewhere it is updated => need to update all other services
        // solution is: delete TEs from all other services and then propagate to scenario e) below
        // console.log('TESyncJob: b1)');

        // loop through all STEOs (except that which TE is updated last)
        for (const serviceTimeEntryObjectWrapper of timeEntrySyncedObjectWrapper.serviceTimeEntryObjectWrappers) {
          if (serviceTimeEntryObjectWrapper !== lastUpdatedServiceTimeEntryObjectWrapper) {

            if (serviceTimeEntryObjectWrapper.timeEntry) {
              console.log("B1 - update")

              const index = timeEntrySyncedObjectWrapper.timeEntrySyncedObject.serviceTimeEntryObjects.indexOf(serviceTimeEntryObjectWrapper.serviceTimeEntryObject);
              if (index == -1) {
                // shouldn't happen but better safe
                Sentry.captureMessage(`Object not found ${serviceTimeEntryObjectWrapper.serviceTimeEntryObject}`);
              }
              timeEntrySyncedObjectWrapper.timeEntrySyncedObject.serviceTimeEntryObjects.splice(index, 1);

              serviceTimeEntryObjectWrapper.timeEntry = await this._updateTimeEntry(
                  serviceTimeEntryObjectWrapper.syncedService,
                  lastUpdatedServiceTimeEntryObjectWrapper.timeEntry,
                  serviceTimeEntryObjectWrapper.timeEntry,
                  otherServicesMappingsObjects,
                  timeEntrySyncedObjectWrapper.timeEntrySyncedObject,
                  serviceTimeEntryObjectWrapper.serviceTimeEntryObject.isOrigin
              );
            } else {
              // delete current TE from the service and continue to the scenario e)
              await serviceTimeEntryObjectWrapper.syncedService.deleteTimeEntry(serviceTimeEntryObjectWrapper.serviceTimeEntryObject.id);
              // set as undefined => use scenario e)
              serviceTimeEntryObjectWrapper.timeEntry = undefined;
            }
          }
        }
      } else {
        // scenario b2) + possibly c) or e)
        // seems ok for now, try if it is not c) or e) too
        // console.log('TESyncJob: b2)');
      }

      for (const serviceTimeEntryObjectWrapper of timeEntrySyncedObjectWrapper.serviceTimeEntryObjectWrappers) {
        if (!serviceTimeEntryObjectWrapper.timeEntry) {
          // scenario e), STEO is there, but TE is missing (it could be both origin or non origin)
          // why it could be origin? Only from b1) above, if user deleted it himself, it would go to scenario d) below
          // need to create new TE (based on lastUpdatedServiceTimeEntryObjectWrapper.timeEntry)
          // console.log('TESyncJob: e)');

          // delete current STEO from the TESO
          const index = timeEntrySyncedObjectWrapper.timeEntrySyncedObject.serviceTimeEntryObjects.indexOf(serviceTimeEntryObjectWrapper.serviceTimeEntryObject);
          timeEntrySyncedObjectWrapper.timeEntrySyncedObject.serviceTimeEntryObjects.splice(index, 1);

          // this method creates new STEO with correct id
          serviceTimeEntryObjectWrapper.timeEntry = await this._createTimeEntryBasedOnTimeEntryModel(
            otherServicesMappingsObjects,
            serviceTimeEntryObjectWrapper.syncedService,
            lastUpdatedServiceTimeEntryObjectWrapper.timeEntry,
            timeEntrySyncedObjectWrapper.timeEntrySyncedObject,
            serviceTimeEntryObjectWrapper.serviceTimeEntryObject.isOrigin,
          );
        }
      }

      for (const serviceWrapper of this._serviceTimeEntriesWrappers) {
        const serviceTimeEntryObjectWrapper = timeEntrySyncedObjectWrapper.serviceTimeEntryObjectWrappers.find(steow => steow.serviceDefinition.name === serviceWrapper.serviceDefinition.name);
        if (!serviceTimeEntryObjectWrapper) {
          // service is missing (probably new one was added recently) => scenario c)
          // create new TE for given service, then create new STEO and add to TESO
          // TE should be created based on lastUpdatedServiceTimeEntryObjectWrapper.timeEntry
          // console.log('TESyncJob: c)');
          await this._createTimeEntryBasedOnTimeEntryModel(
              otherServicesMappingsObjects,
              serviceWrapper.syncedService,
              lastUpdatedServiceTimeEntryObjectWrapper.timeEntry,
              timeEntrySyncedObjectWrapper.timeEntrySyncedObject,
          );
        }
      }
    } else if (timeEntrySyncedObjectWrapper.timeEntrySyncedObject.date === undefined) {
      // ignore legacy TESOs without date
    } else if (Utilities.compare(timeEntrySyncedObjectWrapper.timeEntrySyncedObject.date, someDaysAgoFilter) > 0) {
      // TE missing, but in someDaysAgoFilter
      // firstly try to find it in history (can be on the edge of the someDaysAgoFilter or could be moved by user)
      const originTimeEntry = await originServiceTimeEntryObjectWrapper.syncedService.getTimeEntryById(originServiceTimeEntryObjectWrapper.serviceTimeEntryObject.id, start);

      // not found, delete
      if (!originTimeEntry) {
        // scenario d)
        // console.log('TESyncJob: d)');
        let allDeleted = true;
        for (const serviceTimeEntryObjectWrapper of timeEntrySyncedObjectWrapper.serviceTimeEntryObjectWrappers) {
          // not from origin (TE is already not there) and not if TE already does not exist in the service
          if (serviceTimeEntryObjectWrapper !== originServiceTimeEntryObjectWrapper && serviceTimeEntryObjectWrapper.timeEntry) {
            allDeleted &&= await serviceTimeEntryObjectWrapper.syncedService.deleteTimeEntry(serviceTimeEntryObjectWrapper.serviceTimeEntryObject.id);
            // TODO: Check this console message if needed
            // TODO reuse synced service
            //console.log(`TESyncJob: deleted TE from the ${serviceTimeEntryObjectWrapper.serviceDefinition.name} with id = ${serviceTimeEntryObjectWrapper.serviceTimeEntryObject.id}`);
          }
        }
        if (allDeleted) {
          // no need to await
          databaseService.deleteTimeEntrySyncedObject(timeEntrySyncedObjectWrapper.timeEntrySyncedObject);
        }
        return false;
      }

      // found it in the history
      originServiceTimeEntryObjectWrapper.timeEntry = originTimeEntry;
      // repeat it with the new found origin TE
      return await this._checkTimeEntrySyncedObject(timeEntrySyncedObjectWrapper, someDaysAgoFilter);
    }
    // else ignore (older than someDaysAgoFilter)

    // update TESO with new date mainly (lastUpdated -> remain same!)
    if (originServiceTimeEntryObjectWrapper.timeEntry) {
      this._updateTimeEntrySyncedObject(
        timeEntrySyncedObjectWrapper.timeEntrySyncedObject,
        timeEntrySyncedObjectWrapper.timeEntrySyncedObject.lastUpdated,
        originServiceTimeEntryObjectWrapper.timeEntry.start
      );
    }
    return true;
  }

  private async updateJobLog(errors: Timer2TicketError[])
  {
    this._jobLog.errors = this._jobLog.errors.concat(errors);
    const updated = await databaseService.updateJobLog(this._jobLog);
    if (updated instanceof JobLog) {
      this._jobLog = updated;
    }
  }

  /**
   * Creates a new time entry for given service based on given TE model.
   * Also creates new STEO and pushes it to the given TESO.
   * Updates given TESO's lastUpdated property to newly created TE's date.
   * Returns newly created TE if ok, otherwise undefined
   *
   * @param otherServicesMappingsObjects
   * @param syncedService
   * @param timeEntryModel given TE model
   * @param timeEntrySyncedObject given TESO
   * @param shouldBeOrigin if new TE should be treated as origin (generally true if TE was updated in another non origin service and this serviceDefinition is true origin)
   */
  private async _createTimeEntryBasedOnTimeEntryModel(
    otherServicesMappingsObjects: MappingsObject[],
    syncedService: SyncedService,
    timeEntryModel: TimeEntry,
    timeEntrySyncedObject: TimeEntrySyncedObject,
    shouldBeOrigin = false)
    : Promise<TimeEntry | undefined> {
    const serviceDefinition = syncedService.getServiceDefinition();
    const otherServiceMappingsObjects = otherServicesMappingsObjects.filter(mappingsObject => mappingsObject.service === serviceDefinition.name);

    const serviceObjectsMappings: ServiceObject[] = [];
    for (const otherServiceMappingsObject of otherServiceMappingsObjects) {
      serviceObjectsMappings.push(new ServiceObject(
        otherServiceMappingsObject.id,
        otherServiceMappingsObject.name,
        otherServiceMappingsObject.type,
      ));
    }

    const createdTimeEntry = await syncedService.createTimeEntry(
      timeEntryModel.durationInMilliseconds,
      new Date(timeEntryModel.start),
      new Date(timeEntryModel.end),
      timeEntryModel.text,
      serviceObjectsMappings,
    );

    return await this.handleCreatedTimeEntry(
      createdTimeEntry,
      timeEntrySyncedObject,
      serviceDefinition.name,
      shouldBeOrigin
    )
  }

  private async handleCreatedTimeEntry(
    createdTimeEntry: TimeEntry | null,
    timeEntrySyncedObject: TimeEntrySyncedObject,
    serviceDefinitionName: string,
    shouldBeOrigin: boolean
  ) {
    if (createdTimeEntry) {
      // push newly created STEOs (with isOrigin: false)
      timeEntrySyncedObject.serviceTimeEntryObjects.push(
        new ServiceTimeEntryObject(createdTimeEntry.id, serviceDefinitionName, shouldBeOrigin)
      );

      // lastly created -> update lastUpdate (every created TE will update lastUpdated, but the last created one will be permanent)
      this._updateTimeEntrySyncedObject(timeEntrySyncedObject, createdTimeEntry.lastUpdated, createdTimeEntry.start);

      // check if I need to run config job because the entity used comment prefix as task ID
      if (serviceDefinitionName === 'Redmine') {
        this.needsConfigJob = this.needsConfigJob || createdTimeEntry.needsConfigJob;
      }
    }

    return createdTimeEntry ?? undefined;
  }

  /**
   * Updates a time entry for given service based on given TE model.
   * Also creates new STEO and pushes it to the given TESO.
   * Updates given TESO's lastUpdated property to updated TE's date.
   * Returns updated TE
   *
   * @param syncedService
   * @param updatedTimeEntry
   * @param originalTimeEntry
   * @param otherServicesMappingsObjects
   * @param timeEntrySyncedObject
   * @param shouldBeOrigin
   */
  private async _updateTimeEntry(
      syncedService: SyncedService,
      updatedTimeEntry: TimeEntry,
      originalTimeEntry: TimeEntry,
      otherServicesMappingsObjects: MappingsObject[],
      timeEntrySyncedObject: TimeEntrySyncedObject,
      shouldBeOrigin: boolean) {
    const serviceDefinition = syncedService.getServiceDefinition();

    const serviceObjectsMappings = otherServicesMappingsObjects
      .filter(mappingsObject => mappingsObject.service === serviceDefinition.name)
      .map(mappingsObject => new ServiceObject(mappingsObject.id, mappingsObject.name, mappingsObject.type));

    const createdTimeEntry = await syncedService.updateTimeEntry(
        updatedTimeEntry.durationInMilliseconds,
        new Date(updatedTimeEntry.start),
        updatedTimeEntry.text,
        serviceObjectsMappings,
        originalTimeEntry
    );

    return await this.handleCreatedTimeEntry(
      createdTimeEntry,
      timeEntrySyncedObject,
      serviceDefinition.name,
      shouldBeOrigin
    )
  }

  /**
   * Updates technical properties of given TESO => lastUpdated and date
   * @param timeEntrySyncedObject
   * @param lastUpdated
   * @param date
   */
  private _updateTimeEntrySyncedObject(
    timeEntrySyncedObject: TimeEntrySyncedObject,
    lastUpdated: string | number | Date,
    date: string | number | Date)
    : void {
    timeEntrySyncedObject.lastUpdated = new Date(lastUpdated).getTime();
    timeEntrySyncedObject.date = new Date(Utilities.getOnlyDateString(new Date(date)));
  }

  private _isTimeEntrySyncedObjectArchived(timeEntrySyncedObjectWrapper: TimeEntrySyncedObjectWrapper): boolean {
    return timeEntrySyncedObjectWrapper.timeEntrySyncedObject.archived === true;
  }
}

/**
 * Helper wrapper classes below are not used anywhere else (not exported)
 */
class ServiceTimeEntriesWrapper {
  serviceDefinition: ServiceDefinition;
  syncedService: SyncedService;
  timeEntries: TimeEntry[];

  constructor(serviceDefinition: ServiceDefinition, syncedService: SyncedService, timeEntries: TimeEntry[]) {
    this.serviceDefinition = serviceDefinition;
    this.syncedService = syncedService;
    this.timeEntries = timeEntries;
  }
}

class TimeEntrySyncedObjectWrapper {
  timeEntrySyncedObject: TimeEntrySyncedObject;
  serviceTimeEntryObjectWrappers: ServiceTimeEntryObjectWrapper[];

  constructor(timeEntrySyncedObject: TimeEntrySyncedObject) {
    this.timeEntrySyncedObject = timeEntrySyncedObject;
    this.serviceTimeEntryObjectWrappers = [];
  }
}

class ServiceTimeEntryObjectWrapper {
  serviceTimeEntryObject: ServiceTimeEntryObject;
  timeEntry: TimeEntry | undefined;
  serviceDefinition!: ServiceDefinition;
  syncedService!: SyncedService;

  constructor(serviceTimeEntryObject: ServiceTimeEntryObject) {
    this.serviceTimeEntryObject = serviceTimeEntryObject;
  }
}
