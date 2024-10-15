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
import {User} from "../../models/user";
import {Timer2TicketError} from "../../models/timer2TicketError";
import {SentryService} from "../../shared/sentry_service";
import {ErrorService} from "../../shared/error_service";
import {ServiceTimeEntryObject} from "../../models/synced_service/time_entry_synced_object/service_time_entry_object";
import {ExtraContext} from "../../models/extra_context";

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

  readonly _sentryService: SentryService
  readonly _errorService: ErrorService
  readonly _user: User | null;

  readonly supportsBackwardTagAssignmentAsSource = false;
  readonly supportsBackwardTagAssignmentAsTarget = true;

  public errors: Array<Timer2TicketError>;
  constructor(serviceDefinition: ServiceDefinition, user: User | null) {
    if (serviceDefinition.config.apiPoint === null) {
      //TODO add sentry error
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
    this._sentryService = new SentryService();
    this._errorService = new ErrorService();

    this.errors = [];

    this._user = user;
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
   * @param body
   * @param functionInfo
   * @returns
   */
  private async _retryAndWaitInCaseOfTooManyRequests(request: SuperAgentRequest, functionInfo?: string | undefined, body?: unknown): Promise<superagent.Response> {
    let needToWait = false;

    // call request but with chained retry
    const response = await request
        .retry(2, (err, res) => {

          if (res.status === 429) {
            // cannot wait here, since it cannot be async method (well it can, but it does not wait)
            needToWait = true;
          }
        })
        .catch(err => {
          this.handleResponseException(err, functionInfo ?? request.method + ' ' + request.url, body);
          return err.response;
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
    // TODO change to Not implemented error.
    throw new Error("Redmine is meant to be primary.");
  }

  async updateServiceObject(): Promise<ServiceObject> {
    // Redmine cannot be secondary for now. So this method is not used.
    // TODO change to Not implemented error.
    throw new Error("Redmine is meant to be primary.");
  }

  async deleteServiceObject(): Promise<boolean> {
    // Redmine cannot be secondary for now. So this method is not used.
    // TODO change to Not implemented error.
    throw new Error("Redmine is meant to be primary.");
  }

  async replaceTimeEntryDescription(toggleTimeEntry: ServiceTimeEntryObject, tagId: number | string): Promise<void> {
    throw new Error("Method not implemented");
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
      const response = await this._retryAndWaitInCaseOfTooManyRequests(
          superagent
              .get(this._projectsUri)
              .query(queryParams)
              .accept('application/json')
              .type('application/json')
              .set('X-Redmine-API-Key', this._serviceDefinition.apiKey),
          'getAllProjects'
      );

      if (!response.ok) {
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

  private async _getProjectIds() {
    const projects = await this._getAllProjects();
    return typeof projects !== "boolean" ? projects.map(project => project.id) : [];
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

    const projectIds = await this._getProjectIds();

    const issues: ServiceObject[] = [];

    // issues (paginate)
    do {
      const responseIssues = await this._retryAndWaitInCaseOfTooManyRequests(
          superagent
              .get(this._issuesUri)
              .query(queryParams)
              .accept('application/json')
              .type('application/json')
              .set('X-Redmine-API-Key', this._serviceDefinition.apiKey),
          'getAllAdditionalSOs for issues'
      );

      if (!responseIssues.ok) {
        return false;
      }

      responseIssues.body?.issues.forEach((issue: never) => {
        if (projectIds.indexOf(issue['project']['id']) > -1) {
          issues.push(
              new ServiceObject(
                  issue['id'],
                  issue['subject'],
                  this._issuesType,
              ));
        }
      });

      queryParams.offset += queryParams.limit;
      totalCount = responseIssues.body?.total_count;
    } while (queryParams.offset < totalCount);

    const timeEntryActivities: ServiceObject[] = [];

    const responseTimeEntryActivities = await this._retryAndWaitInCaseOfTooManyRequests(
        superagent
            .get(this._timeEntryActivitiesUri)
            .accept('application/json')
            .type('application/json')
            .set('X-Redmine-API-Key', this._serviceDefinition.apiKey),
        'getAllAdditionalSOs for timeEntryActivities'
    );

    if (!responseTimeEntryActivities.ok) {
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

  async getTimeEntries(start?: Date): Promise<TimeEntry[] | false> {
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
              .set('X-Redmine-API-Key', this._serviceDefinition.apiKey),
          'getTimeEntries'
      );

      if (!response.ok) {
        return false;
      }

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
                timeEntry
            ),
        );
      });

      queryParams.offset += queryParams.limit;
      totalCount = response.body?.total_count;
    } while (queryParams.offset < totalCount);

    return entries;
  }

  async getTimeEntryById(id: number | string, start?: Date): Promise<TimeEntry | null> {
    const response = await this._retryAndWaitInCaseOfTooManyRequests(
        superagent
            .get(this._timeEntryUri.replace('[id]', id.toString()))
            .accept('application/json')
            .type('application/json')
            .set('X-Redmine-API-Key', this._serviceDefinition.apiKey),
        'getTimeEntryById');

    if (!response || response.status === 403 || response.status === 404) {
      return null;
    } else if (!response.ok) {
      // keep the old behaviour for now
      throw response;
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
        response.body
    );
  }

  async getTimeEntriesRelatedToMappingObjectForUser(mapping: Mapping, user: User): Promise<TimeEntry[] | null> {
    let totalCount = 0;
    //console.log('[OMR] -> getTimeEntriesRelatedToMappingObject called!');
    let response;

    if (mapping.primaryObjectType !== "issue") {
      //console.log('getTimeEntriesRelatedToMappingObject supports only issues for now, called on: '.concat(<string>mapping.primaryObjectType, ' type with name=', mapping.name, '!'));
      return null;
    }

    const redmineServiceDefinition = user.serviceDefinitions.find(element => element.name === "Redmine");
    if (typeof redmineServiceDefinition === 'undefined') {
      //console.log('Redmine service definition not found for user '.concat(user.username));
      return null;
    }

    const redmineUserId = redmineServiceDefinition.config.userId;
    //console.log('Nasiel som redmine user id='.concat(redmineUserId.toString()));

    const queryParams: Record<string, any> = {
      limit: this._responseLimit,
      offset: 0,
      issue_id: mapping.primaryObjectId.toString(),
      user_id: redmineUserId
    }

    const entries: RedmineTimeEntry[] = [];

    do {
      response = await this._retryAndWaitInCaseOfTooManyRequests(
          superagent
              .get(this._timeEntriesUri)
              .query(queryParams)
              .accept('application/json')
              .type('application/json')
              .set('X-Redmine-API-Key', this._serviceDefinition.apiKey),
          'getTimeEntriesRelatedToMappingObjectForUser'
      );

      //console.log('[OMR] -> pred response checkom!');
      if (!response || !response.ok) {
        return null;
      }

      //console.log('[OMR] -> response check bez problemov!');

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
                timeEntry
            ),
        );
      });

      queryParams.offset += queryParams.limit;
      totalCount = response.body?.total_count;
    } while (queryParams.offset < totalCount);

    //console.log('[OMR] -> vraciam entries z redmine_synced_service classy, count='.concat(entries.length.toString(), ', totalCount=', totalCount.toString()));

    return entries;
  }

  async createTimeEntry(durationInMilliseconds: number, start: Date, end: Date, text: string, additionalData: ServiceObject[]): Promise<TimeEntry | null> {
    let projectId;
    let issueId;
    let activityId;
    let usedTextId = false;

    for (const data of additionalData) {
      if (data.type === this._projectsType) {
        projectId = data.id;
      } else if (data.type === this._issuesType) {
        issueId = data.id;
      } else if (data.type === this._timeEntryActivitiesType) {
        activityId = data.id;
      }
    }

    if (text && typeof issueId === 'undefined') {
      // checks if TE comment begins with task id
      const regex = /^#(?<project_id>\d+)/;
      const projectId = text.match(regex);
      if (projectId && projectId.groups) {
        issueId = projectId.groups.project_id;
        usedTextId = true;
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
        'createTimeEntry',
        timeEntryBody
    );

    if (!response || !response.ok) {
      //TODO potentially add some minor logging here
      return null;
    }

    const createdStart = new Date(response.body.time_entry['spent_on']);
    const createdEnd = new Date(new Date(response.body.time_entry['spent_on']).setMilliseconds(durationInMilliseconds));
    const createdDurationInMilliseconds = response.body.time_entry['hours'] * 60 * 60 * 1000;
    const date = new Date(response.body.time_entry['updated_on']);
    let lastUpdated;

    // this is used to force T2T to update other services in next sync to add the issue ID to TE
    if (usedTextId) {
      lastUpdated = new Date(date.getTime());
      lastUpdated.setDate(date.getDate() - 1);
    } else {
      lastUpdated = date;
    }

    if (response.body.time_entry.project.id != projectId) {
      lastUpdated = new Date(date.getTime());
      lastUpdated.setDate(date.getDate() - 1);
    }

    return new RedmineTimeEntry(
        response.body.time_entry['id'],
        response.body.time_entry['project']['id'],
        response.body.time_entry['comments'],
        createdStart,
        createdEnd,
        createdDurationInMilliseconds,
        response.body.time_entry['issue'] ? response.body.time_entry['issue']['id'] : undefined,
        response.body.time_entry['activity']['id'],
        lastUpdated,
        response.body.time_entry,
        usedTextId
    );
  }

  async updateTimeEntry(
      durationInMilliseconds: number,
      start: Date,
      text: string,
      additionalData: ServiceObject[],
      originalTimeEntry: RedmineTimeEntry
  ): Promise<TimeEntry> {

    type ProjectObject = {id: number| string, name: string};
    type ActivityObject = {id: number| string, name: string};
    let project: ProjectObject|null = null;
    let issueId;
    let activity: ActivityObject|null = null;

    const timeEntry = new RedmineTimeEntry(
        originalTimeEntry.id,
        originalTimeEntry.projectId,
        originalTimeEntry.text,
        originalTimeEntry.start,
        originalTimeEntry.end,
        originalTimeEntry.durationInMilliseconds,
        originalTimeEntry.issueId,
        originalTimeEntry.activityId,
        originalTimeEntry.lastUpdated,
        null
    );

    for (const data of additionalData) {
      if (data.type === this._projectsType) {
        project = {id: data.id, name: data.name};
      } else if (data.type === this._issuesType) {
        issueId = data.id;
      } else if (data.type === this._timeEntryActivitiesType) {
        activity = {id: data.id, name: data.name};
      }
    }

    const timeEntryBody: Record<string, unknown> = {};

    if (text && typeof issueId === 'undefined') {
      // checks if TE comment begins with task id
      const regex = /^#(?<project_id>\d+)/;
      const projectId = text.match(regex);
      if (projectId && projectId.groups) {
        issueId = projectId.groups.project_id;
      }
    }

    if (issueId && issueId != originalTimeEntry.issueId) {
      timeEntryBody.issue_id = issueId;
      timeEntryBody.project_id = null;
    }

    if (typeof issueId === 'undefined') {
      if (project && project.id != originalTimeEntry.projectId) {
        timeEntryBody.project_id = project.id;
      }

      timeEntryBody.issue_id = null;
    }

    if (activity && activity.id != originalTimeEntry.activityId) {
      timeEntryBody.activity_id = activity.id;
    }

    if (durationInMilliseconds != originalTimeEntry.durationInMilliseconds) {
      const hours = durationInMilliseconds / 1000 / 60 / 60;
      timeEntryBody.hours = (hours === 0.0 || hours > 0.01) ? hours : 0.01;
    }

    const originalDate = new Date(originalTimeEntry.start);
    const startDate = new Date(start);
    originalDate.setHours(0, 0, 0, 0);
    startDate.setHours(0, 0, 0, 0);
    if (Utilities.compare(startDate, originalDate)) {
      timeEntryBody.spent_on = Utilities.getOnlyDateString(start);
    }

    if (text != originalTimeEntry.text) {
      timeEntryBody.comments = text;
    }

    if (Object.keys(timeEntryBody).length === 0) {
      if (text.endsWith(" ")) {
        text = text.trimEnd();
      } else {
        text = text + ' ';
      }
      timeEntryBody.comments = text;
    }

    const response = await this._retryAndWaitInCaseOfTooManyRequests(
        superagent
            .put(this._timeEntryUri.replace('[id]', originalTimeEntry.originalEntry.id.toString()))
            .accept('application/json')
            .type('application/json')
            .set('X-Redmine-API-Key', this._serviceDefinition.apiKey)
            .send({ time_entry: timeEntryBody }),
        'updateTimeEntry'
    );

    if (!response.ok) {
      return timeEntry;
    }

    try {
      const updated = await this.getTimeEntryById(originalTimeEntry.originalEntry.id);
      //if project not in mappings resync just in case
      if (updated && (!project || updated.projectId != project.id)) {
        const date = new Date(updated.lastUpdated);
        updated.lastUpdated = new Date(date.getTime());
        updated.lastUpdated.setDate(date.getDate() - 1);
      }
      return updated ?? timeEntry;

    } catch (error) {
      //TODO handle and report that update somehow failed - but not critical - will be retried :)
      return timeEntry;
    }
  }

  async deleteTimeEntry(id: string | number): Promise<boolean> {
    const response = await this._retryAndWaitInCaseOfTooManyRequests(
        superagent
            .delete(this._timeEntryUri.replace('[id]', id.toString()))
            .accept('application/json')
            .type('application/json')
            .set('X-Redmine-API-Key', this._serviceDefinition.apiKey),
        'deleteTimeEntry'
    );

    return response.ok || response.status === 403 || response.status === 404;
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

  handleResponseException(ex: any, functionInfo: string, body?: unknown): void {
    let context: ExtraContext[] = [];

    if (ex != undefined) {
      context = [
        this._sentryService.createExtraContext("Exception", ex),
        this._sentryService.createExtraContext("Response", ex.response),
      ];
      if (body) {
        context.push();
        context.push(this._sentryService.createExtraContext("Time entry", JSON.parse(JSON.stringify(body))));
      }
    }
    if (ex !== undefined && (ex.response.status === 403 || ex.response.status === 401) ) {
      const error = this._errorService.createRedmineError(ex.response.body.errors);

      //const message = `${functionInfo} failed with status code= ${ex.status} \nplease, fix the apiKey of this user or set him as inactive`
      //this._sentryService.logRedmineError(this._projectsUri, message , context)
      error.data ="API key error. Please check if your API key is correct";
      // console.error('[REDMINE] '.concat(functionInfo, ' failed with status code=', ex.status));
      // console.log('please, fix the apiKey of this user or set him as inactive');
      this.errors.push(error)
    } else {
      //TODO validate if this should be sent to user FE
      const message = `${functionInfo} failed with different reason than 403/401 response code!`
      this._sentryService.logRedmineError(this._projectsUri, message, context)
      // error.data = ''.concat(functionInfo, ' failed with different reason than 403/401 response code!');
      // console.error('[REDMINE] '.concat(functionInfo, ' failed with different reason than 403/401 response code!'));
    }

  }
}
