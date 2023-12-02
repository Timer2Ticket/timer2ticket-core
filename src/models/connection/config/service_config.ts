import { DefaultTimeEntryActivity } from './default_time_entry_activity';
import { FallbackIssue } from './fallback_issue';
import { Workspace } from './workspace';
import { IssueType } from './issue_type';

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
  //for Jira
  fallbackIssue!: FallbackIssue | null

  //for Jira, later Redmine
  ignoredIssueTypes!: IssueType[] // can be empty
}