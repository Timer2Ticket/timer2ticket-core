/* eslint-disable @typescript-eslint/no-explicit-any */
import { Mapping } from "../models/connection/mapping/mapping";
import { MappingsObject } from "../models/connection/mapping/mappings_object";
import { ServiceObject } from "../models/synced_service/service_object/service_object";
import { Constants } from "../shared/constants";
import { databaseService } from "../shared/database_service";
import { Utilities } from "../shared/utilities";
import { SyncedService } from "../synced_services/synced_service";
import { SyncedServiceCreator } from "../synced_services/synced_service_creator";
import { SyncJob } from "./sync_job";
import { TimeEntrySyncedObject } from "../models/synced_service/time_entry_synced_object/time_entry_synced_object";
import { Connection } from "../models/connection/connection";
import { SyncedServiceDefinition } from "../models/connection/config/synced_service_definition";
import { ProjectMapping } from "../models/connection/mapping/project_mapping";
import { jiraSyncedService } from "../synced_services/jira/jira_synced_service";
import { TimeEntry } from "../models/synced_service/time_entry/time_entry";
import { getIdOfAnotherServiceIdFromLink } from "../shared/ticket2ticket_service";
import { isTicket2TicketConnection } from "../shared/ticket2ticket_service";

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
    console.log('Config sync job started for connection '.concat(this._connection._id.toHexString()));
    if (isTicket2TicketConnection(this._connection)) {
      return await this._doTicket2TicketSync()
    } else {
      return await this._doTimer2TicketSync()
    }
  }

  /*
    Does sync between 2 project tools config objects
    Downloads all config objects, creates pairs based on selected mapping custom field,
    creates new and deletes deleted mappings
  */
  private async _doTicket2TicketSync() {
    //get synced services
    const firstSyncedService = SyncedServiceCreator.create(this._connection.firstService)
    const secondSyncedService = SyncedServiceCreator.create(this._connection.secondService)
    //get config objects
    const firstServiceObjectsToSync = await firstSyncedService.getAllServiceObjects(this._connection.firstService.config.customField?.id)
    const secondServiceObjectsToSync = await secondSyncedService.getAllServiceObjects(this._connection.secondService.config.customField?.id)
    if (typeof firstServiceObjectsToSync === "boolean" || typeof secondServiceObjectsToSync === "boolean") {
      const message = `Problem occurred while getting ${firstServiceObjectsToSync === false ? 'first' : 'second'} service objects.`;
      this._jobLog.errors.push(this._errorService.createConfigJobError(message));
      await this.updateConnectionConfigSyncJobLastDone(false);
      return false;
    }
    //filter only issues with 
    const firstServiceIssuesTosync = firstServiceObjectsToSync.filter((o: ServiceObject) => {
      return o.type === 'issue'
    })
    const secondServiceIssuesTosync = secondServiceObjectsToSync.filter((o: ServiceObject) => {
      return o.type === 'issue'
    })
    let newMappings: Mapping[] = []
    try {
      newMappings = await this._createTicket2TicketIssueMappings(firstServiceIssuesTosync, secondServiceIssuesTosync)
    } catch (e: any) {
      const message = `Problem occured while creating Mappings from remote services`
      this._jobLog.errors.push(this._errorService.createConfigJobError(message));
      await this.updateConnectionConfigSyncJobLastDone(false);
      return false
    }
    // Check mappings, if something is wrong, fix it
    // Scenarios (based on objects from primary service):

    // a) Mapping is missing
    //    => create mapping
    const missingMappings: Mapping[] = new Array()
    for (let newMapping of newMappings) {
      const found = this._connection.mappings.find((m: Mapping) => {
        //needs to be checked both ways if objects of mapping are the same because of possible m:n mappping
        //A (for example jira object) can be saved twice in mappingsObjects[], once in relation with B and once with C (redmine objects), hence you need to check the cross reference
        return (
          (m.mappingsObjects[0].id === newMapping.mappingsObjects[0].id &&
            m.mappingsObjects[1].id === newMapping.mappingsObjects[1].id)
          || (m.mappingsObjects[0].id === newMapping.mappingsObjects[1].id &&
            m.mappingsObjects[1].id === newMapping.mappingsObjects[0].id)
        )
      })
      if (!found) {
        missingMappings.push(newMapping)
      }
    }

    // c) Mapping is there, but object is not there (in primary service)
    //    => delete mapping
    const mappingsToDelete: Mapping[] = new Array()
    for (let oldMapping of this._connection.mappings) {
      const found = newMappings.find((m: Mapping) => {
        return m.primaryObjectId === oldMapping.primaryObjectId
      })
      if (!found) {
        mappingsToDelete.push(oldMapping)
      }
    }

    let resultOK = true
    //remove old mappings
    resultOK = await this._deleteObsoleteMappingsAndTESOs(mappingsToDelete)


    //add new mappings
    this._connection.mappings.push(...missingMappings)

    await this.updateConnectionConfigSyncJobLastDone(resultOK);

    // persist changes in the mappings
    // even if some api operations were not ok, persist changes to the mappings - better than nothing
    await databaseService.updateConnectionMappings(this._connection);

    await databaseService.updateJobLog(this._jobLog);

    return resultOK
  }

  private async _doTimer2TicketSync() {
    const primaryServiceDefinition: SyncedServiceDefinition | undefined = Connection.getPrimaryServiceDefinition(this._connection);

    if (!primaryServiceDefinition) {
      throw 'Primary service definition not found.';
    }

    const primarySyncedService = SyncedServiceCreator.create(primaryServiceDefinition);

    // Gets all objects from primary to sync with the other ones
    const objectsToSync = await primarySyncedService.getAllServiceObjects();
    //if we get boolean, a problem occurred while getting data from service (most likely 401 or 403 error)
    //we don't have all the service objects and stop the job
    if (typeof objectsToSync === "boolean") {
      const message = 'Problem occurred while getting primary service objects.';
      this._jobLog.errors.push(this._errorService.createConfigJobError(message));
      await this.updateConnectionConfigSyncJobLastDone(false);
      return false;
    }

    const secondaryServiceDefinition: SyncedServiceDefinition = Connection.getSecondaryServiceDefinition(this._connection);

    const syncedService = SyncedServiceCreator.create(secondaryServiceDefinition);
    const allServiceObjects = await syncedService.getAllServiceObjects();
    //same as above, there was a problem communication problem with service. We stop the job.
    if (typeof allServiceObjects === "boolean") {
      const message = 'Problem occurred while getting secondary service objects';
      this._jobLog.errors.push(this._errorService.createConfigJobError(message));
      await this.updateConnectionConfigSyncJobLastDone(false);
      return false;
    }

    const secondaryServiceWrapper = new SyncedServiceWrapper(
      secondaryServiceDefinition,
      syncedService,
      allServiceObjects,
    );

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
      let mapping = this._connection.mappings.find(
        mapping => mapping.primaryObjectId === objectToSync.id
          && (mapping.primaryObjectType
            ? mapping.primaryObjectType === objectToSync.type
            : mapping.mappingsObjects.find(mo => mo.service === primaryServiceDefinition.name)?.type === objectToSync.type));

      try {
        if (!mapping) {
          // scenario a)
          mapping = await this._createMapping(objectToSync, secondaryServiceWrapper);
        } else {
          // scenario b), d), e), f)
          operationsOk &&= await this._checkMapping(objectToSync, mapping, secondaryServiceWrapper);
        }

        // push to checkedMappings
        // can be undefined from scenario a)
        checkedMappings.push(mapping);
      } catch (ex) {
        operationsOk = false;
        //TODO figure out better way to work with extra context.
        //temporary console log to test if this is the correct place.
        console.log(`User: ${this._user._id} experienced error in config job for object: ${objectToSync.name}, ${objectToSync.type}, ${objectToSync.id}`);
        const context = this._sentryService.createExtraContext('Object_to_sync', JSON.parse(JSON.stringify(objectToSync)));
        this._sentryService.logError(ex, context);
      }
    }

    // obsolete mappings = user's mappings that were not checked => there is no primary object linked to it
    const obsoleteMappings: Mapping[] = [];
    const now = new Date();
    const markedToDeleteTresholdDate = new Date(now.setDate(now.getDate() - Number(Constants.configObjectMappingMarkedToDeleteTresholdInDays)));

    // do not delete now, set markedToDelete to now and delete after some days to allow users to set time to completed tasks which are not fetched from primary etc.
    for (const mapping of this._connection.mappings) {
      // delete object from secondary service because it was deleted in the primary
      const primaryObjectExists = objectsToSync.find((obj: ServiceObject) => {
        return obj.id === mapping.primaryObjectId
      })
      if (!primaryObjectExists) {
        //delete secondary object in the service
        const secondaryServiceObject = mapping.mappingsObjects[0].service === "Toggl Track" ? mapping.mappingsObjects[0] : mapping.mappingsObjects[1]
        //console.log(`about to delete obj from ${secondaryServiceObject.service} with Id ${secondaryServiceObject.id} and name ${secondaryServiceObject.name}`)

        //We do not want to delete immediately, it will be deleted later
        //await syncedService.deleteServiceObject(secondaryServiceObject.id, 'tag')
      }

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

    // console.log('[OMR] -> som za markToDelete, pocet obsolete='.concat(String(obsoleteMappings.length)));

    if (obsoleteMappings.length > 0) {
      const timeEntriesToArchive: Array<TimeEntrySyncedObject> = [];
      for (const mapping of obsoleteMappings) {
        if (mapping.primaryObjectType !== 'issue') {
          // let message = 'OBSOLETE MAPPING SKIP -> typ: '.concat(<string>mapping.primaryObjectType, ' value: ', mapping.name, ' is marked to delete!');
          // add user error
          // console.log(message);
          // // Sentry.captureMessage(message);
          operationsOk &&= await this._deleteMapping(mapping);
          continue;
        }
        //there is no explicit link between TESO and Mappings in the T2T DB
        //we deal with this problem by saving mappings primaryObjectId and its service.
        // With POId and service name, we get all the TimeEntries from API
        // Then we find the related TimeEntrySyncedObjects and set them as archived.
        const primaryObjectId = mapping.primaryObjectId;
        const primaryMappingObjects = mapping.mappingsObjects.filter($object => $object.id === primaryObjectId) //possible 2 mapping objects with same ID can exist, low probability, i dont deal with it here
        if (primaryMappingObjects.length !== 1) {
          operationsOk = false;
          const message = 'primaryMappingObject does not exist or 2 timeEntries with same ID exist';
          this._jobLog.errors.push(this._errorService.createConfigJobError(message));
        } else {
          const primaryMappingObject = primaryMappingObjects[0];
          const primaryObjectServiceName = primaryMappingObject.service;
          if (primaryObjectServiceName !== 'Redmine') {
            operationsOk = false;
            const message = 'Archive TESOs functionality is not yet supported for services other than Redmine!';
            this._jobLog.errors.push(this._errorService.createConfigJobError(message));
          } else {
            const service = SyncedServiceCreator.create(primaryServiceDefinition)
            const relatedTimeEntriesFromApi = await service.getTimeEntriesRelatedToMappingObjectForConnection(mapping, this._connection);
            if (!relatedTimeEntriesFromApi) {
              operationsOk = false;
            } else {
              for (const timeEntryFromApi of relatedTimeEntriesFromApi) {
                const foundTESO = await databaseService.getTimeEntrySyncedObjectForArchiving(timeEntryFromApi.id, primaryObjectServiceName, this._user._id);
                if (foundTESO == null) {
                  // console.log('Null returned from DB findOne!');
                  operationsOk = false;
                } else {
                  // console.log('DB findOne returned TESO with Id='.concat(foundTESO._id.toString()));
                  timeEntriesToArchive.push(foundTESO);
                }
              }
            }
          }
        }

        // scenario c)
        operationsOk &&= await this._deleteMapping(mapping);
      }

      // console.log('[OMR] Archiving '.concat(timeEntriesToArchive.length.toString(), ' TESOs for user ', this._user.username,'.'));
      for (const timeEntryToArchive of timeEntriesToArchive) {
        const updateResponse = await databaseService.makeTimeEntrySyncedObjectArchived(timeEntryToArchive);
        operationsOk &&= updateResponse !== null;
      }

      // and remove all obsolete mappings from user's mappings
      this._connection.mappings
        = this._connection
          .mappings
          .filter(
            mapping => obsoleteMappings.find(obsoleteMapping => obsoleteMapping === mapping)
              === undefined);
    }

    await this.updateConnectionConfigSyncJobLastDone(operationsOk);

    // persist changes in the mappings
    // even if some api operations were not ok, persist changes to the mappings - better than nothing
    await databaseService.updateConnectionMappings(this._connection);

    await databaseService.updateJobLog(this._jobLog);

    console.log("Config sync job for connection " + this._connection._id.toHexString() + " finished.");
    return operationsOk;
  }

  private async updateConnectionConfigSyncJobLastDone(status: boolean) {
    this._connection.configSyncJobDefinition.lastJobTime = new Date().getTime();
    this._connection.configSyncJobDefinition.status = "ERROR";
    if (status) {
      this._connection.configSyncJobDefinition.status = "SUCCESS";
    }

    await databaseService.updateConnectionConfigSyncJobLastDone(this._connection);
  }

  /**
   * Creates mapping based on objectToSync
   * @param user
   * @param objectToSync object from primary service
   */
  private async _createMapping(objectToSync: ServiceObject, serviceWrapper: SyncedServiceWrapper): Promise<Mapping> {
    // is wrapped in try catch block above
    const mapping = new Mapping();
    mapping.primaryObjectId = objectToSync.id;
    mapping.primaryObjectType = objectToSync.type;
    mapping.name = objectToSync.name;

    // create mappingsObject for primary service
    const primaryServiceDefinition = Connection.getPrimaryServiceDefinition(this._connection);

    // do not create real object in the service, it is already there, just create new serviceObject
    const primaryMappingsObject = new MappingsObject(objectToSync.id, objectToSync.name, primaryServiceDefinition!.name, objectToSync.type);
    mapping.mappingsObjects.push(primaryMappingsObject);

    // create mappingsObject for secondary service
    const secondaryServiceDefinition = Connection.getSecondaryServiceDefinition(this._connection);
    if (serviceWrapper) {
      // firstly create object in the service, then create serviceObject with newly acquired id
      const newObject = await this._createServiceObjectInService(serviceWrapper, objectToSync);
      const secondaryMappingsObject = new MappingsObject(newObject.id, newObject.name, secondaryServiceDefinition.name, newObject.type);
      mapping.mappingsObjects.push(secondaryMappingsObject);
    }

    this._connection.mappings.push(mapping);

    return mapping;
  }

  private async _checkMapping(objectToSync: ServiceObject, mapping: Mapping, serviceWrapper: SyncedServiceWrapper): Promise<boolean> {
    // is wrapped in try catch block above
    mapping.name = objectToSync.name;

    const primaryServiceDefinition = Connection.getPrimaryServiceDefinition(this._connection);
    const primaryMappingsObject = new MappingsObject(objectToSync.id, objectToSync.name, primaryServiceDefinition!.name, objectToSync.type);
    if (primaryMappingsObject) {
      primaryMappingsObject.name = objectToSync.name;
    }

    const secondaryServiceDefinition = Connection.getSecondaryServiceDefinition(this._connection);
    if (!serviceWrapper) {
      return true;
    }
    const mappingsObject = mapping.mappingsObjects.find(mappingObject => mappingObject.service === secondaryServiceDefinition.name);

    if (!mappingsObject) {
      // scenario e)
      // mappingObject is missing, create a new one and add to mapping (maybe new service was added)
      // create a real object in the service and add mappingObject
      // firstly create object in the service, then create serviceObject with newly acquired id
      const newObject = await this._createServiceObjectInService(serviceWrapper, objectToSync);
      const newMappingsObject = new MappingsObject(newObject.id, newObject.name, secondaryServiceDefinition.name, newObject.type);
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
        // console.log(`ConfigSyncJob: Updated object ${updatedObject.name}`);
        mappingsObject.name = updatedObject.name;
        mappingsObject.lastUpdated = Date.now();
      } else {
        // scenario d)
        // everything OK, do nothing
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
      // For debugging purposes catching all errors here.
      const context = [
        this._sentryService.createExtraContext("Status_code", ex.status),
        this._sentryService.createExtraContext('Object_to_sync', { 'id': objectToSync.id, 'name': objectToSync.name, 'type': objectToSync.type })
      ]
      this._sentryService.logError(ex, context);
      // 400 ~ maybe object already exists and cannot be created (for example object needs to be unique - name)?
      // => try to find it and use it for the mapping
      const serviceObjectName = serviceWrapper.syncedService.getFullNameForServiceObject(new ServiceObject(objectToSync.id, objectToSync.name, objectToSync.type));
      newObject = serviceWrapper.allServiceObjects.find(serviceObject => serviceObject.name === serviceObjectName);
      if (!newObject) {
        const context = [
          this._sentryService.createExtraContext('Object_to_sync', { 'id': objectToSync.id, 'name': objectToSync.name, 'type': objectToSync.type })
        ]
        this._sentryService.logError(ex, context);
        throw ex;
      }
      // console.log(`ConfigSyncJob: Creating mapping, but object exists, using real object ${newObject.name}`);
    }
    return newObject;
  }

  private async _deleteMapping(mapping: Mapping): Promise<boolean> {
    let operationsOk = true;

    const secondaryServiceDefinition = Connection.getSecondaryServiceDefinition(this._connection);

    for (const mappingObject of mapping.mappingsObjects) {

      // if serviceDefinition isPrimary => means do not delete project from primary service since it is not there
      if (mappingObject.service !== secondaryServiceDefinition.name) continue;

      const syncedService = SyncedServiceCreator.create(secondaryServiceDefinition);
      let operationOk = true;
      try {
        operationOk = await syncedService.deleteServiceObject(mappingObject.id, mappingObject.type);
      } catch (ex: any) {
        if (ex.status === 404) {
          // service object is missing, it is ok to delete the mapping
          operationOk = true;
        } else {
          const context = [
            this._sentryService.createExtraContext('Mapping to delete', { 'id': mappingObject.id, 'type': mappingObject.type })
          ]
          this._sentryService.logError(ex);
          // console.error('err: ConfigSyncJob: delete; exception');
        }
      }
      operationsOk &&= operationOk;
    }

    // if any of those operations did fail, return false
    return operationsOk;
  }

  private async _createTicket2TicketIssueMappings(firstServiceObjects: ServiceObject[], secondServiceObjects: ServiceObject[]): Promise<Mapping[]> {
    const firstServiceIssuesWithCustField = firstServiceObjects.filter((o: ServiceObject) => {
      return o.syncCustomFieldValue
    })
    const secondServiceIssuesWithCustField = secondServiceObjects.filter((o: ServiceObject) => {
      return o.syncCustomFieldValue
    })
    const newMappings: Mapping[] = new Array()
    const firstSecond = await this._createTicket2TicketMapping(firstServiceObjects, secondServiceIssuesWithCustField, true)
    const secondFirst = await this._createTicket2TicketMapping(secondServiceObjects, firstServiceIssuesWithCustField, false)
    newMappings.push(...firstSecond)
    newMappings.push(...secondFirst)
    return newMappings
  }

  private async _createTicket2TicketMapping(firstServiceObjects: ServiceObject[], secondServiceObjectsWithCustField: ServiceObject[], first: boolean): Promise<Mapping[]> {
    const newMappings: Mapping[] = new Array()
    for (const secondObject of secondServiceObjectsWithCustField) {
      const idOfFirst = await getIdOfAnotherServiceIdFromLink(first ? this._connection.firstService : this._connection.secondService, secondObject.syncCustomFieldValue)
      if (idOfFirst) {//'second objects has link to the first => first is primary
        const firstObject = firstServiceObjects.find((o: ServiceObject) => {
          return o.id == idOfFirst
        })
        if (firstObject) {
          //check if projects corespond with those that should be paired
          const areInTheProjectPair = this._connection.projectMappings.filter((p: ProjectMapping) => {
            (p.idFirstService === firstObject.projectId && p.idSecondService === secondObject.projectId)
              || (p.idFirstService === secondObject.projectId && p.idSecondService === firstObject.projectId)
          })
          if (areInTheProjectPair) {
            const mapping = new Mapping()
            mapping.primaryObjectId = firstObject.id
            mapping.primaryObjectType = firstObject.type
            mapping.name = firstObject.name
            mapping.mappingsObjects.push(
              new MappingsObject(
                firstObject.id,
                firstObject.name,
                first ? this._connection.firstService.name : this._connection.secondService.name,
                firstObject.type)
            )
            mapping.mappingsObjects.push(new MappingsObject(
              secondObject.id,
              secondObject.name,
              first ? this._connection.secondService.name : this._connection.firstService.name,
              secondObject.type))
            newMappings.push(mapping)
          }
        }
      }
    }
    return newMappings
  }

  private async _deleteObsoleteMappingsAndTESOs(mappingsToDelete: Mapping[]): Promise<boolean> {
    let success = true
    const timeEntriesToArchive: TimeEntrySyncedObject[] = new Array()
    //find TESOs to Archive
    for (let mapping of mappingsToDelete) {
      const firstService = SyncedServiceCreator.create(this._connection.firstService)
      const secondService = SyncedServiceCreator.create(this._connection.secondService)
      const TESOs: TimeEntry[] = new Array()
      const TESOsFromFirst = await firstService.getTimeEntriesRelatedToMappingObjectForConnection(mapping, this._connection);
      const TESOsFromSecond = await secondService.getTimeEntriesRelatedToMappingObjectForConnection(mapping, this._connection);
      if (TESOsFromFirst)
        TESOs.push(...TESOsFromFirst)
      if (TESOsFromSecond)
        TESOs.push(...TESOsFromSecond)
      if (TESOs) {
        for (let i = 0; i < TESOs.length; i++) {
          const timeEntryFromApi = TESOs[i]
          const firstOrSecond = TESOsFromFirst ? i < TESOsFromFirst.length : false
          const foundTESO = await databaseService.getTimeEntrySyncedObjectForArchiving(
            timeEntryFromApi.id,
            firstOrSecond ? this._connection.firstService.name : this._connection.secondService.name,
            this._user._id);
          if (foundTESO) {
            timeEntriesToArchive.push(foundTESO);
          }
        }
      } else {
        success = false
      }
    }
    //deleteTESOs
    for (const timeEntryToArchive of timeEntriesToArchive) {
      const updateResponse = await databaseService.makeTimeEntrySyncedObjectArchived(timeEntryToArchive);
      if (!updateResponse) {
        success = false
      }
    }
    //delete from service
    const firstSyncedService = SyncedServiceCreator.create(this._connection.firstService)
    const secondSyncedService = SyncedServiceCreator.create(this._connection.secondService)
    mappingsToDelete.forEach(mapping => {
      const secondaryMappingObject = mapping.mappingsObjects[0].id === mapping.primaryObjectId ? mapping.mappingsObjects[0] : mapping.mappingsObjects[1]
      const syncedService = secondaryMappingObject.name === this._connection.firstService.name ? firstSyncedService : secondSyncedService
      try {
        syncedService.deleteServiceObject(secondaryMappingObject.id, secondaryMappingObject.type)
      } catch (ex) {
        //this can fail in case wrong service is called. (Jira and Redmine do not supprot deleting objects)
      }
    })

    //remove Mappings from this.connection...mappings
    this._connection.mappings
      = this._connection
        .mappings
        .filter(
          mapping => mappingsToDelete.find(obsolete => obsolete === mapping)
            === undefined);

    return success
  }
}

class SyncedServiceWrapper {
  syncedServiceDefinition!: SyncedServiceDefinition;
  syncedService!: SyncedService;
  allServiceObjects!: ServiceObject[];

  constructor(syncedServiceDefinition: SyncedServiceDefinition, syncedService: SyncedService, serviceObjects: ServiceObject[]) {
    this.syncedServiceDefinition = syncedServiceDefinition;
    this.syncedService = syncedService;
    this.allServiceObjects = serviceObjects;
  }
}