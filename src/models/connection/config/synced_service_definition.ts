import { ServiceConfig } from './service_config';

export class SyncedServiceDefinition {

  // Service name: Toggl Track, Redmine, Jira
  name!: string;
  config!: ServiceConfig;

  static getSyncServiceName(syncedService: SyncedServiceDefinition): string {
    if(syncedService.name === 'Toggl Track') {
      return syncedService.config.workspace!.name;
    } else if (syncedService.name === 'Redmine') {
      return syncedService.config.apiPoint!;
    } else if (syncedService.name === 'Jira') {
      throw new Error('Not implemented');
    } else {
      throw new Error('Unknown sync service name');
    }
  }
}