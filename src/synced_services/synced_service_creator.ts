import { SyncedService } from "./synced_service";
import { TogglTrackSyncedService } from "./toggl/toggl_synced_service";
import { RedmineSyncedService } from "./redmine/redmine_synced_service";
import { ServiceDefinition } from "../models/service_definition/service_definition";

export class SyncedServiceCreator {
  static create(serviceDefinition: ServiceDefinition): SyncedService {
    switch (serviceDefinition.name) {
      case 'TogglTrack':
        return new TogglTrackSyncedService(serviceDefinition);
      default:
        return new RedmineSyncedService(serviceDefinition);
    }
  }
}