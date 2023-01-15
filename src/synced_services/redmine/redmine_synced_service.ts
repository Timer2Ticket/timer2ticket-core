/* eslint-disable @typescript-eslint/no-explicit-any */
import { ServiceDefinition } from "../../models/service_definition/service_definition";
import { TimeEntry } from "../../models/synced_service/time_entry/time_entry";
import { SyncedService } from "../synced_service";
import superagent, { SuperAgentRequest } from "superagent";
import { ServiceObject } from "../../models/synced_service/service_object/service_object";
import { RedmineTimeEntry } from "../../models/synced_service/time_entry/redmine_time_entry";
import { Utilities } from "../../shared/utilities";
import { MappingsObject } from "../../models/mapping/mappings_object";
import { Mapping } from "../../models/mapping/mapping";
import { Constants } from "../../shared/constants";
import { TimeEntrySyncedObject } from "../../models/synced_service/time_entry_synced_object/time_entry_synced_object";
import {User} from "../../models/user";
import * as Sentry from '@sentry/node';

export class RedmineSyncedService implements SyncedService {
  private _serviceDefinition: ServiceDefinition;

  private _projectsUri: string;
  private _issuesUri: string;
  private _timeEntryActivitiesUri: string;
  private _timeEntriesUri: string;
  private _timeEntryUri: string;

  private _projectsType: string;
  private _issuesType: string;
  private _timeEntryActivitiesType: string;

  private _responseLimit: number;

  constructor(serviceDefinition: ServiceDefinition) {
    if (serviceDefinition.config.apiPoint === null) {
      throw 'Redmine ServiceDefinition apiPoint has to be defined.';
    }

    this._serviceDefinition = serviceDefinition;

    this._projectsUri = `${serviceDefinition.config.apiPoint}projects.json`;
    this._issuesUri = `${serviceDefinition.config.apiPoint}issues.json`; //returns only open issues
    this._timeEntryActivitiesUri = `${serviceDefinition.config.apiPoint}enumerations/time_entry_activities.json`;
    this._timeEntriesUri = `${serviceDefinition.config.apiPoint}time_entries.json`;
    this._timeEntryUri = `${serviceDefinition.config.apiPoint}time_entries/[id].json`;

    this._projectsType = 'project';
    this._issuesType = 'issue';
    this._timeEntryActivitiesType = 'activity';

    this._responseLimit = 50;
  }

  /**
   * Can be awaited for @milliseconds
   * @param milliseconds milliseconds to wait
   * @returns promise to be awaited
   */
  private async _wait(milliseconds = Constants.defaultWaitDurationInCaseOfTooManyRequestsInMilliseconds): Promise<unknown> {
    return new Promise(res => setTimeout(res, milliseconds));
  }

  /**
   * Method to wrap superagent request in case of wanting to retry request.
   * Plus waiting if responded with 429 Too many requests.
   * (Seems like Redmine does not respond with 429, but handled just in case.)
   * @param request 
   * @returns 
   */
  private async _retryAndWaitInCaseOfTooManyRequests(request: SuperAgentRequest, body?: unknown): Promise<superagent.Response> {
    let needToWait = false;

    // call request but with chained retry
    const response = await request
      .retry(2, (err, res) => {
        if (res.status === 429) {
          // cannot wait here, since it cannot be async method (well it can, but it does not wait)
          needToWait = true;
        } else if (res.status === 422) {
          console.error(res.body.errors);
          if (body) { console.error(body); }
        }
      });


    if (needToWait) {
      // wait, because Redmine is responding with 429
      // (Seems like Redmine does not respond with 429, but handled just in case.)
      await this._wait();
    }

    return response;
  }

  async getAllServiceObjects(): Promise<ServiceObject[] | boolean> {
    const projects = await this._getAllProjects();
    const additionalServiceObjects = await this._getAllAdditionalServiceObjects();
    if (typeof projects === "boolean" || typeof additionalServiceObjects === "boolean") {
      return false;
    }
    return projects.concat(additionalServiceObjects);
  }

  async createServiceObject(): Promise<ServiceObject> {
    // Redmine cannot be secondary for now. So this method is not used.
    throw new Error("Redmine is meant to be primary.");
  }

  async updateServiceObject(): Promise<ServiceObject> {
    // Redmine cannot be secondary for now. So this method is not used.
    throw new Error("Redmine is meant to be primary.");
  }

  async deleteServiceObject(): Promise<boolean> {
    // Redmine cannot be secondary for now. So this method is not used.
    throw new Error("Redmine is meant to be primary.");
  }

  getFullNameForServiceObject(serviceObject: ServiceObject): string {
    return serviceObject.name;
  }

  // ***********************************************************
  // PROJECTS **************************************************
  // ***********************************************************

  private async _getAllProjects(): Promise<ServiceObject[] | boolean> {
    let totalCount = 0;

    const queryParams = {
      limit: this._responseLimit,
      offset: 0,
    };

    const projects: ServiceObject[] = [];

    do {
      let response;
      try {
        response = await this._retryAndWaitInCaseOfTooManyRequests(
            superagent
                .get(this._projectsUri)
                .query(queryParams)
                .accept('application/json')
                .type('application/json')
                .set('X-Redmine-API-Key', this._serviceDefinition.apiKey)
        );
      } catch (ex: any) {
        this.handleResponseException(ex, 'getAllProjects');
        return false;
      }


      response.body?.projects.forEach((project: never) => {
        projects.push(
          new ServiceObject(
            project['id'],
            project['name'],
            this._projectsType,
          ));
      });

      queryParams.offset += queryParams.limit;
      totalCount = response.body?.total_count;
    } while (queryParams.offset < totalCount);

    return projects;
  }

  // ***********************************************************
  // OTHER SERVICE OBJECTS *************************************
  // ***********************************************************

  /**
   * Return Issues and Activities both in array of service objects
   */
  private async _getAllAdditionalServiceObjects(): Promise<ServiceObject[] | boolean> {
    let totalCount = 0;

    const queryParams = {
      limit: this._responseLimit,
      offset: 0,
    };

    const issues: ServiceObject[] = [];

    // issues (paginate)
    do {
      let responseIssues;
      try {
        responseIssues = await this._retryAndWaitInCaseOfTooManyRequests(
            superagent
                .get(this._issuesUri)
                .query(queryParams)
                .accept('application/json')
                .type('application/json')
                .set('X-Redmine-API-Key', this._serviceDefinition.apiKey)
        );
      } catch (ex: any) {
        this.handleResponseException(ex, 'getAllAdditionalSOs for issues')
        return false;
      }


      responseIssues.body?.issues.forEach((issue: never) => {
        issues.push(
          new ServiceObject(
            issue['id'],
            issue['subject'],
            this._issuesType,
          ));
      });

      queryParams.offset += queryParams.limit;
      totalCount = responseIssues.body?.total_count;
    } while (queryParams.offset < totalCount);

    const timeEntryActivities: ServiceObject[] = [];

    let responseTimeEntryActivities;
    try {
      // time entry activities (do not paginate)
      responseTimeEntryActivities = await this._retryAndWaitInCaseOfTooManyRequests(
          superagent
              .get(this._timeEntryActivitiesUri)
              .accept('application/json')
              .type('application/json')
              .set('X-Redmine-API-Key', this._serviceDefinition.apiKey)
      );
    } catch (ex: any) {
      this.handleResponseException(ex, 'getAllAdditionalSOs for timeEntryActivities')
      return false;
    }


    responseTimeEntryActivities.body?.time_entry_activities.forEach((timeEntryActivity: never) => {
      timeEntryActivities.push(
        new ServiceObject(
          timeEntryActivity['id'],
          timeEntryActivity['name'],
          this._timeEntryActivitiesType,
        ));
    });

    // return concatenation of two arrays
    return issues.concat(timeEntryActivities);
  }

  // ***********************************************************
  // TIME ENTRIES **********************************************
  // ***********************************************************

  async getTimeEntries(start?: Date): Promise<TimeEntry[]> {
    let totalCount = 0;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const queryParams: Record<string, any> = {
      limit: this._responseLimit,
      offset: 0,
      user_id: this._serviceDefinition.config.userId,
      from: start ? Utilities.getOnlyDateString(start) : null,
    };

    const entries: RedmineTimeEntry[] = [];

    do {
      const response = await this._retryAndWaitInCaseOfTooManyRequests(
        superagent
          .get(this._timeEntriesUri)
          .query(queryParams)
          .accept('application/json')
          .type('application/json')
          .set('X-Redmine-API-Key', this._serviceDefinition.apiKey)
      );

      response.body['time_entries'].forEach((timeEntry: never) => {
        const durationInMilliseconds = timeEntry['hours'] * 60 * 60 * 1000;
        const start = new Date(timeEntry['spent_on']);
        const end = new Date(new Date(timeEntry['spent_on']).setMilliseconds(durationInMilliseconds));

        entries.push(
          new RedmineTimeEntry(
            timeEntry['id'],
            timeEntry['project']['id'],
            timeEntry['comments'],
            start,
            end,
            durationInMilliseconds,
            timeEntry['issue'] ? timeEntry['issue']['id'] : undefined,
            timeEntry['activity']['id'],
            new Date(timeEntry['updated_on']),
          ),
        );
      });

      queryParams.offset += queryParams.limit;
      totalCount = response.body?.total_count;
    } while (queryParams.offset < totalCount);

    return entries;
  }

  async getTimeEntryById(id: number | string, start?: Date): Promise<TimeEntry | null> {
    let response;
    try {
      response = await this._retryAndWaitInCaseOfTooManyRequests(
        superagent
          .get(this._timeEntryUri.replace('[id]', id.toString()))
          .accept('application/json')
          .type('application/json')
          .set('X-Redmine-API-Key', this._serviceDefinition.apiKey)
      );
    } catch (err: any) {
      if (err && (err.status === 403 || err.status === 404)) {
        return null;
      } else {
        throw err;
      }
    }

    if (!response || !response.ok) {
      return null;
    }

    const durationInMilliseconds = response.body.time_entry['hours'] * 60 * 60 * 1000;
    const teStart = new Date(response.body.time_entry['spent_on']);
    const teEnd = new Date(new Date(response.body.time_entry['spent_on']).setMilliseconds(durationInMilliseconds));

    return new RedmineTimeEntry(
      response.body.time_entry['id'],
      response.body.time_entry['project']['id'],
      response.body.time_entry['comments'],
      teStart,
      teEnd,
      durationInMilliseconds,
      response.body.time_entry['issue'] ? response.body.time_entry['issue']['id'] : undefined,
      response.body.time_entry['activity']['id'],
      new Date(response.body.time_entry['updated_on']),
    );
  }

  async getTimeEntriesRelatedToMappingObjectForUser(mapping: Mapping, user: User): Promise<TimeEntry[] | null> {
    let totalCount = 0;
    console.log('[OMR] -> getTimeEntriesRelatedToMappingObject called!');
    let response;

    if (mapping.primaryObjectType !== "issue") {
      console.log('getTimeEntriesRelatedToMappingObject supports only issues for now, called on: '.concat(<string>mapping.primaryObjectType, ' type with name=', mapping.name, '!'));
      return null;
    }

    let redmineServiceDefinition = user.serviceDefinitions.find(element => element.name === "Redmine");
    if (typeof redmineServiceDefinition === 'undefined') {
      console.log('Redmine service definition not found for user '.concat(user.username));
      return null;
    }

    let redmineUserId = redmineServiceDefinition.config.userId;
    console.log('Nasiel som redmine user id='.concat(redmineUserId.toString()));

    const queryParams: Record<string, any> = {
      limit: this._responseLimit,
      offset: 0,
      issue_id: mapping.primaryObjectId.toString(),
      user_id: redmineUserId
    }

    const entries: RedmineTimeEntry[] = [];

    do {
      try {
        console.log('[OMR] -> posielam request! s queryParams.offset='.concat(queryParams.offset.toString()));
        response = await this._retryAndWaitInCaseOfTooManyRequests(
            superagent
                .get(this._timeEntriesUri)
                .query(queryParams)
                .accept('application/json')
                .type('application/json')
                .set('X-Redmine-API-Key', this._serviceDefinition.apiKey)
        );
      } catch (err: any) {
        console.log('[OMR] -> chyteny error v response try - catch bloku!');
        Sentry.captureException(err);
        return null;
      }

      console.log('[OMR] -> pred response checkom!');
      if (!response || !response.ok) {
        return null;
      }

      console.log('[OMR] -> response check bez problemov!');

      response.body['time_entries'].forEach((timeEntry: never) => {//TODO refactor to make it non-duplicated code
        const durationInMilliseconds = timeEntry['hours'] * 60 * 60 * 1000;
        const start = new Date(timeEntry['spent_on']);
        const end = new Date(new Date(timeEntry['spent_on']).setMilliseconds(durationInMilliseconds));

        entries.push(
            new RedmineTimeEntry(
                timeEntry['id'],
                timeEntry['project']['id'],
                timeEntry['comments'],
                start,
                end,
                durationInMilliseconds,
                timeEntry['issue'] ? timeEntry['issue']['id'] : undefined,
                timeEntry['activity']['id'],
                new Date(timeEntry['updated_on']),
            ),
        );
      });

      queryParams.offset += queryParams.limit;
      totalCount = response.body?.total_count;
    } while (queryParams.offset < totalCount);

    console.log('[OMR] -> vraciam entries z redmine_synced_service classy, count='.concat(entries.length.toString(), ', totalCount=', totalCount.toString()));

    return entries;
  }

  async createTimeEntry(durationInMilliseconds: number, start: Date, end: Date, text: string, additionalData: ServiceObject[]): Promise<TimeEntry | null> {
    let projectId;
    let issueId;
    let activityId;

    for (const data of additionalData) {
      if (data.type === this._projectsType) {
        projectId = data.id;
      } else if (data.type === this._issuesType) {
        issueId = data.id;
      } else if (data.type === this._timeEntryActivitiesType) {
        activityId = data.id;
      }
    }

    if (!issueId && !projectId) {
      // issueId or projectId is required
      return null;
    }

    // when user chooses both issue and project, ignore project, issue only is required
    // it solves also problem when user (accidentally) chooses issue and project, but issue is not assigned to chosen project
    // if provided with both (and wrong ones), RM will respond with 422
    if (issueId && projectId) {
      projectId = null;
    }

    const hours = durationInMilliseconds / 1000 / 60 / 60;
    const timeEntryBody: Record<string, unknown> = {
      // minimum value in Redmine is 0.01, so if it is empty, insert exact 0.0, something between => 0.01, else > 0.01
      hours: (hours === 0.0 || hours > 0.01) ? hours : 0.01,
      spent_on: Utilities.getOnlyDateString(start),
      comments: text,
      user_id: this._serviceDefinition.config.userId,
      // if activityId not specified => fill with default from config
      activity_id: activityId ? activityId : this._serviceDefinition.config.defaultTimeEntryActivity?.id,
    };

    if (issueId) {
      timeEntryBody['issue_id'] = issueId;
    } else if (projectId) {
      timeEntryBody['project_id'] = projectId;
    }

    const response = await this._retryAndWaitInCaseOfTooManyRequests(
      superagent
        .post(this._timeEntriesUri)
        .accept('application/json')
        .type('application/json')
        .set('X-Redmine-API-Key', this._serviceDefinition.apiKey)
        .send({ time_entry: timeEntryBody }),
      timeEntryBody
    );

    if (!response || !response.ok) {
      return null;
    }

    const createdStart = new Date(response.body.time_entry['spent_on']);
    const createdEnd = new Date(new Date(response.body.time_entry['spent_on']).setMilliseconds(durationInMilliseconds));
    const createdDurationInMilliseconds = response.body.time_entry['hours'] * 60 * 60 * 1000;

    return new RedmineTimeEntry(
      response.body.time_entry['id'],
      response.body.time_entry['project']['id'],
      response.body.time_entry['comments'],
      createdStart,
      createdEnd,
      createdDurationInMilliseconds,
      response.body.time_entry['issue'] ? response.body.time_entry['issue']['id'] : undefined,
      response.body.time_entry['activity']['id'],
      new Date(response.body.time_entry['updated_on']),
    );
  }

  async deleteTimeEntry(id: string | number): Promise<boolean> {
    try {
      const response = await this._retryAndWaitInCaseOfTooManyRequests(
        superagent
          .delete(this._timeEntryUri.replace('[id]', id.toString()))
          .accept('application/json')
          .type('application/json')
          .set('X-Redmine-API-Key', this._serviceDefinition.apiKey)
      );

      return response.ok;
    } catch (err: any) {
      if (err && (err.status === 403 || err.status === 404)) {
        return true;
      } else {
        return false;
      }
    }
  }

  /**
   * Extracts project, issue and time entry activity and returns them as mappingObjects
   * @param timeEntry 
   * @param mappings 
   */
  extractMappingsObjectsFromTimeEntry(timeEntry: TimeEntry, mappings: Mapping[]): MappingsObject[] {
    // this should not happen
    if (!(timeEntry instanceof RedmineTimeEntry)) return [];

    const mappingsObjectsResult: MappingsObject[] = [];
    for (const mapping of mappings) {
      // ===  'Redmine' (is stored in this._serviceDefinition.name)
      const redmineMappingsObject = mapping.mappingsObjects.find(mappingsObject => mappingsObject.service === this._serviceDefinition.name);

      if (redmineMappingsObject) {
        // find project's mapping - should have same id as timeEntry.projectId
        if ((redmineMappingsObject.id === timeEntry.projectId && redmineMappingsObject.type === this._projectsType)
          || (redmineMappingsObject.id === timeEntry.issueId && redmineMappingsObject.type === this._issuesType)
          || (redmineMappingsObject.id === timeEntry.activityId && redmineMappingsObject.type === this._timeEntryActivitiesType)) {
          const otherProjectMappingsObjects = mapping.mappingsObjects.filter(mappingsObject => mappingsObject.service !== this._serviceDefinition.name);
          // push to result all other than 'Redmine'
          mappingsObjectsResult.push(...otherProjectMappingsObjects);
        }
      }
    }
    return mappingsObjectsResult;
  }

  handleResponseException(ex: any, functionInfo: string): void {
    if (ex !== undefined && (ex.status === 403 || ex.status === 401) ) {
      console.error('[REDMINE] '.concat(functionInfo, ' failed with status code=', ex.status));
      console.log('please, fix the apiKey of this user or set him as inactive');
    } else {
      console.error('[REDMINE] '.concat(functionInfo, ' failed with different reason than 403/401 response code!'));
    }
  }
}
