/* eslint-disable @typescript-eslint/no-explicit-any */
import { Mapping } from "../models/mapping/mapping";
import { MappingsObject } from "../models/mapping/mappings_object";
import { ServiceDefinition } from "../models/service_definition/service_definition";
import { ServiceObject } from "../models/synced_service/service_object/service_object";
import { databaseService } from "../shared/database_service";
import { SyncedServiceCreator } from "../synced_services/synced_service_creator";
import { SyncJob } from "./sync_job";
import {SyncedServiceWrapper} from "../models/synced_service/synced_service_wrapper";

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
    // console.log('[OMR] config_sync_job started for user '.concat(this._user.username));
    const primaryServiceDefinition: ServiceDefinition | undefined
      = this._user.serviceDefinitions.find(serviceDefinition => serviceDefinition.isPrimary);

    if (!primaryServiceDefinition) {
      throw 'Primary service definition not found.';
    }

    const primarySyncedService = SyncedServiceCreator.create(primaryServiceDefinition);

    const configLastSyncAt = this._user.configSyncJobDefinition.lastSuccessfullyDone;
    // Gets all objects from primary to sync with the other ones
    const objectsToSync = await primarySyncedService.getAllServiceObjects(configLastSyncAt);
    //if we get boolean, a problem occurred while getting data from service (most likely 401 or 403 error)
    //we dont have all the service objects and stop the job
    if (typeof objectsToSync === "boolean") {
      await this.updateJobLog(primarySyncedService.errors)
      return false;
    }

    // Also, prepare all secondary services' service objects to speed up the process
    const secondaryServicesWrappersMap: Map<string, SyncedServiceWrapper> = new Map();
    const secondaryServiceDefinitions
      = this._user.serviceDefinitions.filter(serviceDefinition => serviceDefinition.isPrimary === false);

    for (const secondaryServiceDefinition of secondaryServiceDefinitions) {
      const syncedService = SyncedServiceCreator.create(secondaryServiceDefinition);
      const allServiceObjects = await syncedService.getAllServiceObjects(configLastSyncAt);
      //same as above, there was a problem communication problem with service. We stop the job.
      if (typeof allServiceObjects === "boolean") {
        await this.updateJobLog(syncedService.errors)
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
    // c) Mapping is there and is the same as primary object
    //    => do nothing
    // d) Mapping is there, but mappingObject for given service is missing
    //    => create objects in service and add mappingObject to the mapping
    // e) Mapping is there, mappingObject for given service too, but real object is missing
    //    => create object in service

    // Also, if new service was added, this job should do the right job as it is

    let operationsOk = true;

    // Check all objectsToSync and their corresponding mapping (syncing of objects)
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
          // scenario b), c), d), e)
          const result = await this._checkMapping(objectToSync, mapping, secondaryServicesWrappersMap);
          operationsOk &&= result;
        }
      } catch (ex) {
        operationsOk = false;
      }
    }

    // console.log('[OMR] -> som za markToDelete, pocet obsolete='.concat(String(obsoleteMappings.length)));

    if (operationsOk) {
      // if all operations OK => set lastSuccessfullyDone (important to set not null for starting TE syncing)
      this._user.configSyncJobDefinition.lastSuccessfullyDone = new Date().getTime();
      await databaseService.updateUserConfigSyncJobLastSuccessfullyDone(this._user);
    }

    // persist changes in the mappings
    // even if some api operations were not ok, persist changes to the mappings - better than nothing
    await databaseService.updateUserMappings(this._user);

    await this.updateJobLog(Array.from(secondaryServicesWrappersMap.values()).flatMap(wrapper => wrapper.syncedService?.errors ?? []));

    return operationsOk;
  }

  /**
   * Creates mapping based on objectToSync
   * @param objectToSync object from primary service
   * @param secondaryServicesWrappersMap
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
        const newObject = await serviceWrapper.syncedService.createServiceObject(objectToSync.id, objectToSync.name, objectToSync.type);
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
        // scenario d)
        // mappingObject is missing, create a new one and add to mapping (maybe new service was added)
        // create a real object in the service and add mappingObject
        // firstly create object in the service, then create serviceObject with newly acquired id
        const newObject = await serviceWrapper.syncedService.createServiceObject(objectToSync.id, objectToSync.name, objectToSync.type);
        const newMappingsObject = new MappingsObject(newObject.id, newObject.name, serviceDefinition.name, newObject.type);
        mapping.mappingsObjects.push(newMappingsObject);
      } else {
        // scenario b), c), e)
        // check if mapping corresponds with real object in the service
        const objectBasedOnMapping = serviceWrapper.allServiceObjects
          .find(serviceObject => serviceObject.id === mappingsObject.id && serviceObject.type === mappingsObject.type);

        if (!objectBasedOnMapping) {
          // scenario e), create new object in the service
          const newObject = await serviceWrapper.syncedService.createServiceObject(objectToSync.id, objectToSync.name, objectToSync.type);
          mappingsObject.id = newObject.id;
          mappingsObject.name = newObject.name;
          mappingsObject.lastUpdated = Date.now();
        } else if (objectBasedOnMapping.name !== serviceWrapper.syncedService.getFullNameForServiceObject(objectToSync)) {
          // scenario b)
          // name is incorrect => maybe mapping was outdated or/and real object was outdated
          const updatedObject = await serviceWrapper.syncedService.updateServiceObject(
              mappingsObject.id, new ServiceObject(objectToSync.id, objectToSync.name, objectToSync.type)
          );
          // console.log(`ConfigSyncJob: Updated object ${updatedObject.name}`);
          mappingsObject.name = updatedObject.name;
          mappingsObject.lastUpdated = Date.now();
        } else {
          // scenario c)
          // everything OK, do nothing
        }
      }
    }

    return true;
  }
}
