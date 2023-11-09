import { SyncedService } from "./synced_service";
import { TogglTrackSyncedService } from "./toggl/toggl_synced_service";
import { RedmineSyncedService } from "./redmine/redmine_synced_service";
import { SyncedServiceDefinition } from "../models/connection/config/synced_service_definition";
import { jiraSyncedService } from "./jira/jira_synced_service";

export class SyncedServiceCreator {
  static create(syncedServiceConfig: SyncedServiceDefinition): SyncedService {
    switch (syncedServiceConfig.name) {
      case 'Toggl Track':
        return new TogglTrackSyncedService(syncedServiceConfig);
      case 'Jira':
        return new jiraSyncedService(syncedServiceConfig);
      default:
        return new RedmineSyncedService(syncedServiceConfig);
    }
  }
}