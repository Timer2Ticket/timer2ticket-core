/* eslint-disable @typescript-eslint/no-explicit-any */
import { Mapping } from "../models/mapping/mapping";
import { MappingsObject } from "../models/mapping/mappings_object";
import { ServiceDefinition } from "../models/service_definition/service_definition";
import { ServiceObject } from "../models/synced_service/service_object/service_object";
import { Constants } from "../shared/constants";
import { databaseService } from "../shared/database_service";
import { Utilities } from "../shared/utilities";
import { SyncedService } from "../synced_services/synced_service";
import { SyncedServiceCreator } from "../synced_services/synced_service_creator";
import { SyncJob } from "./sync_job";
import {TimeEntrySyncedObject} from "../models/synced_service/time_entry_synced_object/time_entry_synced_object";

export class ConfigSyncJob extends SyncJob {
  /**
   * This job takes mappings from the user and checks if there are any problems with them
   * If there are no mappings, job is called probably for the first time for this user
   * Should create all mappings and sync all projects, issues etc. from primary service to the other ones
   * 
   * If mappings are there, should check if all are correct and updated
   * E.g. looks for project definition in one service and checks if mapping is synced in PRIMARY (for example name could change, or project has been deleted)
   * If not, updates mappings and propagates change through other services
   * Additionally, checks if anything is missing in the secondary services and it should be there (user could delete it by mistake)
   */
  protected async _doTheJob(): Promise<boolean> {
    console.log('[OMR] config_sync_job started for user '.concat(this._user.username));
    const primaryServiceDefinition: ServiceDefinition | undefined
      = this._user.serviceDefinitions.find(serviceDefinition => serviceDefinition.isPrimary);

    if (!primaryServiceDefinition) {
      throw 'Primary service definition not found.';
    }

    const primarySyncedService = SyncedServiceCreator.create(primaryServiceDefinition);

    // Gets all objects from primary to sync with the other ones
    const objectsToSync = await primarySyncedService.getAllServiceObjects();
    //if we get boolean, a problem occurred while getting data from service (most likely 401 or 403 error)
    //we dont have all the service objects and stop the job
    if (typeof objectsToSync === "boolean") {
      console.error('Problem occurred while getting primary service objects of user='.concat(this._user.username, ', job stopped.'));
      return false;
    }

    // Also, prepare all secondary services' service objects to speed up the process
    const secondaryServicesWrappersMap: Map<string, SyncedServiceWrapper> = new Map();
    const secondaryServiceDefinitions
      = this._user.serviceDefinitions.filter(serviceDefinition => serviceDefinition.isPrimary === false);

    for (const secondaryServiceDefinition of secondaryServiceDefinitions) {
      const syncedService = SyncedServiceCreator.create(secondaryServiceDefinition);
      const allServiceObjects = await syncedService.getAllServiceObjects();
      //same as above, there was a problem communication problem with service. We stop the job.
      if (typeof allServiceObjects === "boolean") {
        console.error('Problem occurred while getting secondary service objects of user='.concat(this._user.username, ', job stopped.'));
        return false;
      }

      secondaryServicesWrappersMap.set(
        secondaryServiceDefinition.name,
        new SyncedServiceWrapper(
          secondaryServiceDefinition,
          syncedService,
          allServiceObjects,
        )
      );
    }

    // Check primary objects and mappings, if something is wrong, fix it
    // Scenarios (based on objects from primary service):
    // a) Mapping is missing
    //    => create mapping, propagate objects to other services
    // b) Mapping is there, but is incorrect (for example project name changed)
    //    => update mapping, propagate changes to other services
    // c) Mapping is there, but object is not there (in primary service)
    //    => delete objects from other services and delete mapping
    // d) Mapping is there and is the same as primary object
    //    => do nothing
    // e) Mapping is there, but mappingObject for given service is missing
    //    => create objects in service and add mappingObject to the mapping
    // f) Mapping is there, mappingObject for given service too, but real object is missing
    //    => create object in service

    // Also, if new service was added, this job should do the right job as it is

    // array of checked mappings (new ones or existing ones), used for finding obsolete mappings
    const checkedMappings: Mapping[] = [];

    let operationsOk = true;

    // Check all objectsToSync and their corresponding mapping
    for (const objectToSync of objectsToSync) {
      // find by its id and type (finding type in mapping.mappingsObjects is for legacy support)
      let mapping = this._user.mappings.find(
        mapping => mapping.primaryObjectId === objectToSync.id
          && (mapping.primaryObjectType
            ? mapping.primaryObjectType === objectToSync.type
            : mapping.mappingsObjects.find(mo => mo.service === primaryServiceDefinition.name)?.type === objectToSync.type));

      try {
        if (!mapping) {
          // scenario a)
          mapping = await this._createMapping(objectToSync, secondaryServicesWrappersMap);
        } else {
          // scenario b), d), e), f)
          operationsOk &&= await this._checkMapping(objectToSync, mapping, secondaryServicesWrappersMap);
        }

        // push to checkedMappings
        // can be undefined from scenario a)
        checkedMappings.push(mapping);
      } catch (ex) {
        operationsOk = false;
        console.error('err: ConfigSyncJob: create || check; exception');
      }
    }

    // obsolete mappings = user's mappings that were not checked => there is no primary object linked to it
    const obsoleteMappings: Mapping[] = [];
    const now = new Date();
    const markedToDeleteTresholdDate = new Date(now.setDate(now.getDate() - Constants.configObjectMappingMarkedToDeleteTresholdInDays));

    // do not delete now, set markedToDelete to now and delete after some days to allow users to set time to completed tasks which are not fetched from primary etc.
    for (const mapping of this._user.mappings) {
      const isObsolete = checkedMappings.find(checkedMapping => checkedMapping === mapping) === undefined;
      if (isObsolete && mapping.markedToDelete) {
        // check if days passed from when it was markedToDelete
        if (Utilities.compare(mapping.markedToDelete, markedToDeleteTresholdDate) < 0) {
          // if yes => delete mapping and all objects from other services (add to array for delete below)
          obsoleteMappings.push(mapping);
        }
        // else do nothing, wait for markedToDelete to reach the treshold
      } else if (isObsolete && mapping.markedToDelete === undefined) {
        // set markedToDelete to now only
        mapping.markedToDelete = new Date();
      }
    }

    console.log('[OMR] -> som za markToDelete, pocet obsolete='.concat(String(obsoleteMappings.length)));

    if (obsoleteMappings.length > 0) {
      const timeEntriesToArchive: Array<TimeEntrySyncedObject> = [];
      for (const mapping of obsoleteMappings) {
        //there is no explicit link between TESO and Mappings in the T2T DB
        //we deal with this problem by saving mappings primaryObjectId and its service.
        // With POId and service name, we get all the TimeEntries from API
        // Then we find the related TimeEntrySyncedObjects and set them as archived.
        const primaryObjectId = mapping.primaryObjectId;
        const primaryMappingObjects = mapping.mappingsObjects.filter($object => $object.id === primaryObjectId) //possible 2 mapping objects with same ID can exist, low probability, i dont deal with it here
        if (primaryMappingObjects.length !== 1) {
          operationsOk = false;
          console.error('err: ConfigSyncJob: primaryMappingObject does not exist or 2 timeEntries with same ID exist');
        } else {
          const primaryMappingObject = primaryMappingObjects[0];
          const primaryObjectServiceName = primaryMappingObject.service;
          if (primaryObjectServiceName !== 'Redmine') {
            operationsOk = false;
            console.error('Archive TESOs functionality is not yet supported for services other than Redmine!');
          } else {
            const service = SyncedServiceCreator.create(primaryServiceDefinition)
            const relatedTimeEntriesFromApi = await service.getTimeEntriesRelatedToMappingObject(mapping);
            if (!relatedTimeEntriesFromApi) {
              operationsOk = false;
            } else {
              //bolo by vhodne mat vacsiu funkcionalitu, bud z pohladu pristupu na DB (getovanie TESO na zaklade api timeEntryID),
              // ako aj na urovni programu, hodilo by sa mat reusable funkciu, ktora dokaze getnut TESO pre timeEntry, podobne sa to vyuziva aj v time-entries-jobe
              const timeEntrySyncedObjectsFromDb = await databaseService.getTimeEntrySyncedObjects(this._user);
              if (!timeEntrySyncedObjectsFromDb) {
                operationsOk = false;
                console.error('Failed getting TESOs from DB!');
              } else {
                //loop trough api time entries
                for (const timeEntryFromApi of relatedTimeEntriesFromApi) {
                  //loop trough db timeEntrySyncedObjects
                  for (const timeEntrySyncedObjectFromDb of timeEntrySyncedObjectsFromDb) {
                    //search in TESOs STEOs
                    const foundFlag = timeEntrySyncedObjectFromDb.serviceTimeEntryObjects.find(
                        $object => $object.service === primaryServiceDefinition.name && $object.id === timeEntryFromApi.id) !== null;
                    //only one TESO connects to one timeEntry, we can break here to save time.
                    if (foundFlag) {
                      timeEntriesToArchive.push(timeEntrySyncedObjectFromDb)
                      break;
                    }
                  }
                }
              }
            }
          }
        }

        // scenario c)
        operationsOk &&= await this._deleteMapping(mapping);
      }

      console.log('[OMR] Archiving '.concat(timeEntriesToArchive.length.toString(), ' TESOs for user ', this._user.username,'.'));
      for (const timeEntryToArchive of timeEntriesToArchive) {
        const updateResponse = await databaseService.makeTimeEntrySyncedObjectArchived(timeEntryToArchive);
        operationsOk &&= updateResponse !== null;
      }

      // and remove all obsolete mappings from user's mappings
      this._user.mappings
        = this._user
          .mappings
          .filter(
            mapping => obsoleteMappings.find(obsoleteMapping => obsoleteMapping === mapping)
              === undefined);
    }

    if (operationsOk) {
      // if all operations OK => set lastSuccessfullyDone (important to set not null for starting TE syncing)
      this._user.configSyncJobDefinition.lastSuccessfullyDone = new Date().getTime();
      await databaseService.updateUserConfigSyncJobLastSuccessfullyDone(this._user);
    }

    // persist changes in the mappings
    // even if some api operations were not ok, persist changes to the mappings - better than nothing
    await databaseService.updateUserMappings(this._user);

    return operationsOk;
  }

  /**
   * Creates mapping based on objectToSync
   * @param user
   * @param objectToSync object from primary service
   */
  private async _createMapping(objectToSync: ServiceObject, secondaryServicesWrappersMap: Map<string, SyncedServiceWrapper>): Promise<Mapping> {
    // is wrapped in try catch block above
    const mapping = new Mapping();
    mapping.primaryObjectId = objectToSync.id;
    mapping.primaryObjectType = objectToSync.type;
    mapping.name = objectToSync.name;

    // for each service, create mappingsObject
    for (const serviceDefinition of this._user.serviceDefinitions) {
      let mappingsObject;
      if (serviceDefinition.isPrimary) {
        // do not create real object in the service, it is already there, just create new serviceObject
        mappingsObject = new MappingsObject(objectToSync.id, objectToSync.name, serviceDefinition.name, objectToSync.type);
      } else {
        const serviceWrapper = secondaryServicesWrappersMap.get(serviceDefinition.name);
        if (!serviceWrapper) {
          continue;
        }
        // firstly create object in the service, then create serviceObject with newly acquired id
        const newObject = await this._createServiceObjectInService(serviceWrapper, objectToSync);
        mappingsObject = new MappingsObject(newObject.id, newObject.name, serviceDefinition.name, newObject.type);
      }

      mapping.mappingsObjects.push(mappingsObject);
    }

    this._user.mappings.push(mapping);

    return mapping;
  }

  private async _checkMapping(objectToSync: ServiceObject, mapping: Mapping, secondaryServicesWrappersMap: Map<string, SyncedServiceWrapper>): Promise<boolean> {
    // is wrapped in try catch block above
    mapping.name = objectToSync.name;
    for (const serviceDefinition of this._user.serviceDefinitions) {
      if (serviceDefinition.isPrimary) {
        // for primary service, update only name, everything else should be ok
        const primaryMappingsObject = mapping.mappingsObjects.find(mappingObject => mappingObject.service === serviceDefinition.name);
        if (primaryMappingsObject) {
          primaryMappingsObject.name = objectToSync.name;
        }
        continue;
      }

      const serviceWrapper = secondaryServicesWrappersMap.get(serviceDefinition.name);
      if (!serviceWrapper) {
        continue;
      }

      const mappingsObject = mapping.mappingsObjects.find(mappingObject => mappingObject.service === serviceDefinition.name);

      if (!mappingsObject) {
        // scenario e)
        // mappingObject is missing, create a new one and add to mapping (maybe new service was added)
        // create a real object in the service and add mappingObject
        // firstly create object in the service, then create serviceObject with newly acquired id
        const newObject = await this._createServiceObjectInService(serviceWrapper, objectToSync);
        const newMappingsObject = new MappingsObject(newObject.id, newObject.name, serviceDefinition.name, newObject.type);
        mapping.mappingsObjects.push(newMappingsObject);
      } else {
        // scenario b), d), f)
        // check if mapping corresponds with real object in the service
        const objectBasedOnMapping = await serviceWrapper.allServiceObjects
          .find(serviceObject => serviceObject.id === mappingsObject.id && serviceObject.type === mappingsObject.type);

        if (!objectBasedOnMapping) {
          // scenario f), create new object in the service
          const newObject = await this._createServiceObjectInService(serviceWrapper, objectToSync);
          mappingsObject.id = newObject.id;
          mappingsObject.name = newObject.name;
          mappingsObject.lastUpdated = Date.now();
        } else if (objectBasedOnMapping.name !== serviceWrapper.syncedService.getFullNameForServiceObject(objectToSync)) {
          // scenario b)
          // name is incorrect => maybe mapping was outdated or/and real object was outdated
          const updatedObject = await serviceWrapper.syncedService.updateServiceObject(
            mappingsObject.id, new ServiceObject(objectToSync.id, objectToSync.name, objectToSync.type)
          );
          console.log(`ConfigSyncJob: Updated object ${updatedObject.name}`);
          mappingsObject.name = updatedObject.name;
          mappingsObject.lastUpdated = Date.now();
        } else {
          // scenario d)
          // everything OK, do nothing
        }
      }
    }

    return true;
  }

  private async _createServiceObjectInService(serviceWrapper: SyncedServiceWrapper, objectToSync: ServiceObject): Promise<ServiceObject> {
    let newObject;
    try {
      newObject = await serviceWrapper.syncedService.createServiceObject(objectToSync.id, objectToSync.name, objectToSync.type);
    } catch (ex: any) {
      if (ex.status !== 400) {
        throw ex;
      }
      // 400 ~ maybe object already exists and cannot be created (for example object needs to be unique - name)?
      // => try to find it and use it for the mapping
      const serviceObjectName = serviceWrapper.syncedService.getFullNameForServiceObject(new ServiceObject(objectToSync.id, objectToSync.name, objectToSync.type));
      newObject = serviceWrapper.allServiceObjects.find(serviceObject => serviceObject.name === serviceObjectName);
      if (!newObject) {
        // not found, rethrow exception
        throw ex;
      }
      console.log(`ConfigSyncJob: Creating mapping, but object exists, using real object ${newObject.name}`);
    }
    return newObject;
  }

  private async _deleteMapping(mapping: Mapping): Promise<boolean> {
    let operationsOk = true;

    for (const mappingObject of mapping.mappingsObjects) {
      const serviceDefinition = this._user.serviceDefinitions.find(serviceDefinition => serviceDefinition.name === mappingObject.service);

      // if serviceDefinition not found or isPrimary => means do not delete project from primary service since it is not there
      if (!serviceDefinition || serviceDefinition.isPrimary) continue;

      const syncedService = SyncedServiceCreator.create(serviceDefinition);
      let operationOk = true;
      try {
        operationOk = await syncedService.deleteServiceObject(mappingObject.id, mappingObject.type);
      } catch (ex: any) {
        if (ex.status === 404) {
          // service object is missing, it is ok to delete the mapping
          operationOk = true;
        } else {
          console.error('err: ConfigSyncJob: delete; exception');
        }
      }
      operationsOk &&= operationOk;
    }

    // if any of those operations did fail, return false
    return operationsOk;
  }
}

class SyncedServiceWrapper {
  serviceDefinition!: ServiceDefinition;
  syncedService!: SyncedService;
  allServiceObjects!: ServiceObject[];

  constructor(serviceDefinition: ServiceDefinition, syncedService: SyncedService, serviceObjects: ServiceObject[]) {
    this.serviceDefinition = serviceDefinition;
    this.syncedService = syncedService;
    this.allServiceObjects = serviceObjects;
  }
}