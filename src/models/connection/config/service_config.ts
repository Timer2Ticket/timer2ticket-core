import { DefaultTimeEntryActivity } from './default_time_entry_activity';
import { Workspace } from './workspace';

export class ServiceConfig {
  /**
   * shared
   */
  userId!: number;
  apiKey!: string;
  // For Redmine
  defaultTimeEntryActivity!: DefaultTimeEntryActivity | null;
  // For Redmine
  apiPoint!: string | null;
  // For Toggl track
  workspace!: Workspace | null;
  // For Jira
  userEmail!: string | null;
  // For Jira
  domain!: string | null
}