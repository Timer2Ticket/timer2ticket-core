/* eslint-disable @typescript-eslint/no-explicit-any */
import {ServiceDefinition} from "../../models/service_definition/service_definition";
import {TimeEntry} from "../../models/synced_service/time_entry/time_entry";
import {SyncedService} from "../synced_service";
import superagent, {SuperAgentRequest} from "superagent";
import {ServiceObject} from "../../models/synced_service/service_object/service_object";
import {RedmineTimeEntry} from "../../models/synced_service/time_entry/redmine_time_entry";
import {Utilities} from "../../shared/utilities";
import {MappingsObject} from "../../models/mapping/mappings_object";
import {Mapping} from "../../models/mapping/mapping";
import {Constants} from "../../shared/constants";
import {User} from "../../models/user";
import {Timer2TicketError} from "../../models/timer2TicketError";
import {SentryService} from "../../shared/sentry_service";
import {ErrorService} from "../../shared/error_service";
import {ServiceTimeEntryObject} from "../../models/synced_service/time_entry_synced_object/service_time_entry_object";
import {IssueStatus} from "../../models/synced_service/redmine/issue_status";
import {ProjectStatus} from "../../models/synced_service/redmine/project_status";

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
            const error = this._errorService.createRedmineError(res.body.errors);
          const context =  [
            this._sentryService.createExtraContext("Status_code", {'status_code': res.status})
          ]
            if (body) {
              // don't know how to create context from body otherwise. This is a band-aid solution.
              context.push(this._sentryService.createExtraContext("Time entry", JSON.parse(JSON.stringify(body))));
              error.data = body;
            }
            this.errors.push(error);
            this._sentryService.logRedmineError(this._projectsUri, res.body.errors, context)
          }
      });


    if (needToWait) {
      // wait, because Redmine is responding with 429
      // (Seems like Redmine does not respond with 429, but handled just in case.)
      await this._wait();
    }

    return response;
  }


  private _getISOStringWithCETTimeZone(date: Date): string {
    const localeString = date.toLocaleString('en-US', {
      timeZone: 'CET',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const month = localeString.split('/')[0];
    const day = localeString.split('/')[1];
    const year = localeString.split('/')[2].split(',')[0];
    let time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).split(' ')[0];
    if (time == '24:00:00') {
        time = '00:00:00';
    }
    return `${year}-${month}-${day}T${time}Z`;
  }

  async getAllRemovableObjectsWithinDate(startAt: Date | null, endAt: Date | null): Promise<ServiceObject[] | boolean> {
    try {
      const startAtDate = startAt ? this._getISOStringWithCETTimeZone(startAt) : null;
      const endAtDate = endAt ? this._getISOStringWithCETTimeZone(endAt) : null;
      const projects = await this._getAllClosedProjects(startAtDate, endAtDate);
      console.log("Projekty na smazání (pouze closed): " + projects)
      const issues = await this._getAllClosedIssues(startAtDate, endAtDate);
      console.log("Issues na smazání: " + issues)
      return projects.concat(issues);
    } catch (err: any) {
      return false;
    }
  }

  async getAllServiceObjects(lastSyncAt: number | null): Promise<ServiceObject[] | boolean> {
    // Convert timestamp to ISO date, Redmine does not support milliseconds in Date
    const lastSyncAtDate = lastSyncAt === null ? null : new Date(lastSyncAt).toISOString().split('.')[0] + "Z";
    try {
      const projects = await this._getAllProjects(lastSyncAtDate);
      const additionalServiceObjects = await this._getAllAdditionalServiceObjects(lastSyncAtDate);
      return projects.concat(additionalServiceObjects);
    } catch (err: any){
      return false;
    }
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

  private async _getAllClosedProjects(startDate: string | null, endDate: string | null = null): Promise<ServiceObject[]> {
    const queryParams = {
      limit: this._responseLimit,
      offset: 0,
      status: ProjectStatus.CLOSED,
      updated_on: startDate && endDate
          ? `><${startDate}|${endDate}`
          : startDate
              ? `>=${startDate}`
              : endDate
                  ? `<=${endDate}`
                  : undefined,
    };
    return this.fetchProjects(queryParams);
  }

  private async _getAllProjects(lastSyncAtDate: string | null): Promise<ServiceObject[]> {
    const queryParams = {
      limit: this._responseLimit,
      offset: 0,
      updated_on: undefined as string | undefined,
    };

    if (lastSyncAtDate !== null)
      queryParams.updated_on = `>=${lastSyncAtDate}`;

    return this.fetchProjects(queryParams);
  }

  // ***********************************************************
  // OTHER SERVICE OBJECTS *************************************
  // ***********************************************************

  private async _getAllClosedIssues(startDate: string | null, endDate: string | null = null): Promise<ServiceObject[]> {
    const queryParams = {
      limit: this._responseLimit,
      offset: 0,
      'status_id': IssueStatus.CLOSED,
      closed_on: startDate && endDate
          ? `><${startDate}|${endDate}`
          : startDate
              ? `>=${startDate}`
              : endDate
                  ? `<=${endDate}`
                  : undefined,
    };
    return await this.fetchIssues(queryParams);
  }

  /**
   * Return Issues and Activities both in array of service objects
   */
  private async _getAllIssues(startDate: string | null, endDate: string | null = null, issueStatus: IssueStatus = IssueStatus.ACTIVE): Promise<ServiceObject[]> {
    const queryParams = {
      limit: this._responseLimit,
      offset: 0,
      'status_id': issueStatus,
      updated_on: startDate && endDate
        ? `><${startDate}|${endDate}`
        : startDate
          ? `>=${startDate}`
          : endDate
            ? `<=${endDate}`
            : undefined,
    };
    return await this.fetchIssues(queryParams);
  }

  private async fetchProjects(queryParams: { limit: number; offset: number; [key: string]: any }): Promise<ServiceObject[]> {
    let totalCount = 0;
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
        throw ex;
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

  private async fetchIssues(queryParams: { limit: number; offset: number; [key: string]: any }): Promise<ServiceObject[]> {
    let totalCount = 0;
    const issues: ServiceObject[] = [];

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
        this.handleResponseException(ex, 'fetchIssues');
        throw ex;
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

    return issues;
  }

  private async _getAllAdditionalServiceObjects(lastSyncAtDate: string | null): Promise<ServiceObject[]> {
    let totalCount = 0;

    const queryParams = {
      limit: this._responseLimit,
      offset: 0,
      // get issues only from active projects
      'project.status': ProjectStatus.ACTIVE,
      updated_on: undefined as string | undefined,
    };

    if (lastSyncAtDate !== null)
      queryParams.updated_on = `>=${lastSyncAtDate}`;

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
        throw ex;
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
      throw ex;
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
      try {
        //console.log('[OMR] -> posielam request! s queryParams.offset='.concat(queryParams.offset.toString()));
        response = await this._retryAndWaitInCaseOfTooManyRequests(
            superagent
                .get(this._timeEntriesUri)
                .query(queryParams)
                .accept('application/json')
                .type('application/json')
                .set('X-Redmine-API-Key', this._serviceDefinition.apiKey)
        );
      } catch (err: any) {
        //console.log('[OMR] -> chyteny error v response try - catch bloku!');
        this._sentryService.logRedmineError(this._projectsUri, err)
        return null;
      }

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

    try {
      await this._retryAndWaitInCaseOfTooManyRequests(
          superagent
              .put(this._timeEntryUri.replace('[id]', originalTimeEntry.originalEntry.id.toString()))
              .accept('application/json')
              .type('application/json')
              .set('X-Redmine-API-Key', this._serviceDefinition.apiKey)
              .send({ time_entry: timeEntryBody }),
      )

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
      const error = this._errorService.createRedmineError(ex);
      const context =  [
        this._sentryService.createExtraContext("Exception", ex),
        this._sentryService.createExtraContext("Status_code", ex.status)
      ]

      const message = `${functionInfo} failed with status code= ${ex.status} \nplease, fix the apiKey of this user or set him as inactive`
      this._sentryService.logRedmineError(this._projectsUri, message , context)
      error.data ="API key error. Please check if your API key is correct";
      // console.error('[REDMINE] '.concat(functionInfo, ' failed with status code=', ex.status));
      // console.log('please, fix the apiKey of this user or set him as inactive');
      this.errors.push(error)
    } else {
      //TODO validate if this should be sent to user FE

      const message = `${functionInfo} failed with different reason than 403/401 response code!`
      this._sentryService.logRedmineError(this._projectsUri, message)
      // error.data = ''.concat(functionInfo, ' failed with different reason than 403/401 response code!');
      // console.error('[REDMINE] '.concat(functionInfo, ' failed with different reason than 403/401 response code!'));
    }
  }

  async getServiceObjects(ids: (string | number)[]): Promise<ServiceObject[]> {
    if (ids.length > this._responseLimit) {
        throw 'Redmine does not support more than 50 ids in one request.';
    }
    const issues: ServiceObject[] = [];
    const queryParams = {
      limit: this._responseLimit,
      issue_id: ids.join(','),
      status_id: '*'
    };
    try {
      const responseIssues = await this._retryAndWaitInCaseOfTooManyRequests(
        superagent
          .get(this._issuesUri)
          .query(queryParams)
          .accept('application/json')
          .type('application/json')
          .set('X-Redmine-API-Key', this._serviceDefinition.apiKey)
      );
      responseIssues.body?.issues.forEach((issue: never) => {
        issues.push(
          new ServiceObject(
            issue['id'],
            issue['subject'],
            this._issuesType,
          ));
      });
      return issues;
    } catch (ex: any) {
      this.handleResponseException(ex, 'getServiceObjects');
      throw ex;
    }
  }
}
