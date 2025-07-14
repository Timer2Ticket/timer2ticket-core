/* eslint-disable @typescript-eslint/no-explicit-any */
import {Mapping} from "../models/mapping/mapping";
import {ServiceDefinition} from "../models/service_definition/service_definition";
import {Constants} from "../shared/constants";
import {databaseService} from "../shared/database_service";
import {SyncedServiceCreator} from "../synced_services/synced_service_creator";
import {SyncJob} from "./sync_job";
import {TimeEntrySyncedObject} from "../models/synced_service/time_entry_synced_object/time_entry_synced_object";
import {SyncedServiceWrapper} from "../models/synced_service/synced_service_wrapper";
import {SyncedService} from "../synced_services/synced_service";

export class RemoveObsoleteMappingsJob extends SyncJob {
    /**
     * This job removes mappings that are no longer valid.
     *
     * Case 1 - remove mappings of closed, rejected or postponed issues
     * Case 2 - remove mappings with non-existing service object in primary service
     */
    protected async _doTheJob(): Promise<boolean> {
        const primaryServiceDefinition: ServiceDefinition | undefined
            = this._user.serviceDefinitions.find(serviceDefinition => serviceDefinition.isPrimary);
        const userMappings = this._user.mappings ?? [];
        if (!primaryServiceDefinition) {
            throw 'Primary service definition not found.';
        }

        const primarySyncedService = SyncedServiceCreator.create(primaryServiceDefinition);

        const lastRemovalDate = this._user.removeObsoleteMappingsJobDefinition.lastSuccessfullyDone
            ? new Date(this._user.removeObsoleteMappingsJobDefinition.lastSuccessfullyDone)
            : null;
        // Gets all objects from primary to sync with the other ones
        // case 1 - remove closed issues
        const now = new Date();
        lastRemovalDate?.setHours(0,0,0,0);
        const removeUntilDate = new Date(now.setDate(now.getDate() - Constants.configObjectMappingMarkedToDeleteTresholdInDays));
        removeUntilDate.setHours(23, 59, 59, 999);
        const removableObjects = await primarySyncedService.getAllRemovableObjectsWithinDate(lastRemovalDate, removeUntilDate);
        let obsoleteMappings: Mapping[] = [];

        if (typeof removableObjects !== "boolean") {
            for (const objectToRemove of removableObjects) {
                obsoleteMappings.push(...userMappings.filter(
                    mapping => mapping.primaryObjectId == objectToRemove.id &&
                        mapping.primaryObjectType == objectToRemove.type &&
                        (mapping.primaryObjectType == 'issue' || mapping.primaryObjectType == 'project' )));
            }
        } else {
            await this.updateJobLog(primarySyncedService.errors);
        }

        // case 2 - remove mappings with non-existing service object in primary service
        const mappingChunks = this._chunkArray(userMappings.filter(mapping => mapping.primaryObjectType == 'issue'), 50);
        for (const chunk of mappingChunks) {
            try {
                const issues = await primarySyncedService.getServiceObjects(chunk.map(mapping => mapping.primaryObjectId));
                if (issues.length !== chunk.length) {
                    // some issues were not found - find mappings to remove
                    const foundIssueIds = new Set(issues.map(issue => issue.id));
                    const notFoundMappings = chunk.filter(mapping => !foundIssueIds.has(mapping.primaryObjectId));
                    obsoleteMappings.push(...notFoundMappings);
                }
            } catch (err: any) {
                await this.updateJobLog(primarySyncedService.errors);
                // keep old behaviour
                // throw err;
            }
        }

        //console.log('Obsolete mappings: ', obsoleteMappings);

        // remove duplicates
        obsoleteMappings = Array.from(new Set(obsoleteMappings));

        const operationsOk = await this._deleteObsoleteMappings(obsoleteMappings, primaryServiceDefinition);
        if (operationsOk) {
            this._user.removeObsoleteMappingsJobDefinition.lastSuccessfullyDone = removeUntilDate.getTime();
            await databaseService.updateUserRemoveObsoleteMappingsJobLastSuccessfullyDone(this._user);
        }
        // persist changes in the mappings
        // even if some api operations were not ok, persist changes to the mappings - better than nothing
        await databaseService.updateUserMappings(this._user);

        await this.updateJobLog([]);

        return operationsOk;
    }

    /**
     * Deletes mapping from all services except the primary one
     * @param mapping
     * @param syncedServiceMap
     * @private
     */
    private async _deleteMapping(mapping: Mapping, syncedServiceMap: Map<string, SyncedService>): Promise<boolean> {
        let operationsOk = true;

        for (const mappingObject of mapping.mappingsObjects) {
            const syncedService = syncedServiceMap.get(mappingObject.service);
            if (!syncedService) continue;
            let operationOk = true;
            try {
                operationOk = await syncedService.deleteServiceObject(mappingObject.id, mappingObject.type, mappingObject.name);
            } catch (ex: any) {
                if (ex.status === 404) {
                    // service object is missing, it is ok to delete the mapping
                    operationOk = true;
                } else {
                    operationOk &&= ex.response.ok;
                    if (syncedService.errors.length > 0) {
                        this._jobLog.errors.push(syncedService.errors[syncedService.errors.length - 1]);
                    }
                }
            }
            operationsOk &&= operationOk;
        }

        // if any of those operations did fail, return false
        return operationsOk;
    }

    private _chunkArray<T>(array: T[], chunkSize: number): T[][] {
        const result: T[][] = [];
        for (let i = 0; i < array.length; i += chunkSize) {
            const chunk = array.slice(i, i + chunkSize);
            result.push(chunk);
        }
        return result;
    }

    private async _deleteObsoleteMappings(obsoleteMappings: Mapping[], primaryServiceDefinition: ServiceDefinition): Promise<boolean> {
        let operationsOk = true;
        const timeEntriesToArchive: Array<TimeEntrySyncedObject> = [];
        const syncedServiceMap = this._createSyncedServiceMap();
        for (const mapping of obsoleteMappings) {
            if (mapping.primaryObjectType !== 'issue') {
                const result = await this._deleteMapping(mapping, syncedServiceMap);
                operationsOk &&= result;
                continue;
            }
            // there is no explicit link between TESO (TimeEntrySyncedObject) and Mappings in the T2T DB
            // we deal with this problem by saving mappings primaryObjectId and its service.
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
                    const relatedTimeEntriesFromApi = await service.getTimeEntriesRelatedToMappingObjectForUser(mapping, this._user);
                    if (!relatedTimeEntriesFromApi) {
                        operationsOk = false;
                        if (service.errors.length > 0) {
                            this._jobLog.errors.push(service.errors[service.errors.length - 1]);
                        }
                    } else {
                        for (const timeEntryFromApi of relatedTimeEntriesFromApi) {
                            const foundTESO = await databaseService.getTimeEntrySyncedObjectForArchiving(timeEntryFromApi.id, primaryObjectServiceName, this._user._id);
                            if (foundTESO == null) {
                                // console.log('Null returned from DB findOne!');
                                operationsOk = false;
                            } else {
                                // console.log('DB findOne returned TESO with Id='.concat(foundTESO._id.toString()));
                                foundTESO.issueName = mapping.mappingsObjects.find(element => element.service === "TogglTrack")?.name;
                                timeEntriesToArchive.push(foundTESO);
                            }
                        }
                    }
                }
            }

            operationsOk &&= await this._deleteMapping(mapping, syncedServiceMap);

            //TODO figure out how to pass TogglTrack in better
            const secondaryServiceDefinition
                = this._user.serviceDefinitions.find(serviceDefinition => serviceDefinition.name === "TogglTrack");
            // console.log('[OMR] Archiving '.concat(timeEntriesToArchive.length.toString(), ' TESOs for user ', this._user.username,'.'));
            for (const timeEntryToArchive of timeEntriesToArchive) {

                if (secondaryServiceDefinition !== undefined) {
                    const syncedService = SyncedServiceCreator.create(secondaryServiceDefinition);
                    const togglService = new SyncedServiceWrapper(
                        secondaryServiceDefinition,
                        syncedService,
                        [],
                    )
                    const toggleTimeEntry = timeEntryToArchive.serviceTimeEntryObjects.find(
                        (element) => element.service === "TogglTrack");
                    if (toggleTimeEntry !== undefined && timeEntryToArchive.issueName !== undefined) {
                        try {
                            await togglService.syncedService.replaceTimeEntryDescription(toggleTimeEntry, timeEntryToArchive.issueName)
                        } catch (exception) {
                            operationsOk = false;
                            if (togglService.syncedService.errors.length > 0) {
                                this._jobLog.errors.push(togglService.syncedService.errors[togglService.syncedService.errors.length - 1]);
                            }
                        }
                    }

                }
                const updateResponse = await databaseService.makeTimeEntrySyncedObjectArchived(timeEntryToArchive);
                operationsOk &&= updateResponse !== null;
            }

            // and remove all obsolete mappings from user's mappings
            this._user.mappings = this._user.mappings.filter(
                mapping => obsoleteMappings.find(obsoleteMapping => obsoleteMapping === mapping) === undefined
            ) ?? [];
        }
        return operationsOk;
    }

    private _createSyncedServiceMap() {
        const syncedServiceMap = new Map<string, SyncedService>();
        for (const serviceDefinition of this._user.serviceDefinitions) {
            if (serviceDefinition.isPrimary) continue;
            const syncedService = SyncedServiceCreator.create(serviceDefinition);
            syncedServiceMap.set(serviceDefinition.name, syncedService);
        }
        return syncedServiceMap;
    }
}
