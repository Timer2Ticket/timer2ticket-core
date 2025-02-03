import {ServiceDefinition} from "../service_definition/service_definition";
import {SyncedService} from "../../synced_services/synced_service";
import {ServiceObject} from "./service_object/service_object";

/**
 * This class is a wrapper for SyncedService and ServiceDefinition
 */
export class SyncedServiceWrapper {
  serviceDefinition!: ServiceDefinition;
  syncedService!: SyncedService;
  allServiceObjects!: ServiceObject[];

  constructor(serviceDefinition: ServiceDefinition, syncedService: SyncedService, serviceObjects: ServiceObject[]) {
    this.serviceDefinition = serviceDefinition;
    this.syncedService = syncedService;
    this.allServiceObjects = serviceObjects;
  }
}
