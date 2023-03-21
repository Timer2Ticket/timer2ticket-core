import { ServiceDefinition } from "../../models/service_definition/service_definition";
import { TimeEntry } from "../../models/synced_service/time_entry/time_entry";
import { SyncedService } from "../synced_service";
import superagent, { SuperAgentRequest } from "superagent";
import { TogglTimeEntry } from "../../models/synced_service/time_entry/toggl_time_entry";
import { ServiceObject } from "../../models/synced_service/service_object/service_object";
import { Mapping } from "../../models/mapping/mapping";
import { MappingsObject } from "../../models/mapping/mappings_object";
import { Constants } from "../../shared/constants";
import {User} from "../../models/user";
import * as Sentry from "@sentry/node";

export class TogglTrackSyncedService implements SyncedService {
  private _serviceDefinition: ServiceDefinition;

  private _baseUri: string;
  private _userUri: string;
  private _workspacesUri: string;
  private _projectsUri: string;
  private _tagsUri: string;
  private _timeEntriesUri: string;
  private _reportsUri: string;

  private _projectsType: string;
  private _tagsType: string;

  private _responseLimit: number;

  constructor(serviceDefinition: ServiceDefinition) {
    this._serviceDefinition = serviceDefinition;

    this._baseUri = 'https://api.track.toggl.com/';
    this._userUri = `${this._baseUri}api/v8/me`;
    this._workspacesUri = `${this._baseUri}api/v8/workspaces`;
    this._projectsUri = `${this._baseUri}api/v8/projects`;
    this._tagsUri = `${this._baseUri}api/v8/tags`;
    this._timeEntriesUri = `${this._baseUri}api/v8/time_entries`;
    this._reportsUri = `${this._baseUri}reports/api/v2/details`;

    this._projectsType = 'project';
    this._tagsType = 'tag';

    // defined by Toggl, cannot override
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
   * @param request 
   * @returns 
   */
  private async _retryAndWaitInCaseOfTooManyRequests(request: SuperAgentRequest): Promise<superagent.Response> {
    let needToWait = false;

    // call request but with chained retry
    const response = await request
      .retry(2, (err, res) => {
        if (res.status === 429) {
          // cannot wait here, since it cannot be async method (well it can, but it does not wait)
          needToWait = true;
        }
      });


    if (needToWait) {
      // wait, because Toggl Track is responding with 429
      await this._wait();
    }

    return response;
  }

  async getAllServiceObjects(): Promise<ServiceObject[] | boolean> {
    const projects = await this._getAllProjects();
    const tags = await this._getAllTags();
    if (typeof projects == "boolean" || typeof tags === "boolean") {
      return false;
    }
    return projects.concat(tags);
  }

  async createServiceObject(objectId: number, objectName: string, objectType: string): Promise<ServiceObject> {
    switch (objectType) {
      case this._projectsType:
        return await this._createProject(objectName);
      default:
        return await this._createTag(objectId, objectName, objectType);
    }
  }

  async updateServiceObject(objectId: string | number, serviceObject: ServiceObject): Promise<ServiceObject> {
    switch (serviceObject.type) {
      case this._projectsType:
        return await this._updateProject(objectId, serviceObject);
      default:
        return await this._updateTag(objectId, serviceObject);
    }
  }

  async deleteServiceObject(id: string | number, objectType: string): Promise<boolean> {
    switch (objectType) {
      case this._projectsType:
        return await this._deleteProject(id);
      default:
        return await this._deleteTag(id);
    }
  }

  getFullNameForServiceObject(serviceObject: ServiceObject): string {
    switch (serviceObject.type) {
      case this._projectsType:
        return serviceObject.name;
      case this._tagsType:
        return serviceObject.name;
      case 'activity':
        return `! ${serviceObject.name} (${serviceObject.type})`;
      case 'issue':
        return `#${serviceObject.id} ${serviceObject.name} (${serviceObject.type})`;
      default:
        return `${serviceObject.name} (${serviceObject.type})`;
    }
  }

  // private async _getUser(): Promise<any> {
  //   return (await superagent
  //     .get(this._userUri)
  //     .auth(this.serviceDefinition.apikey, 'api_token'))
  //     .body
  //     .data;
  // }


  // ***********************************************************
  // PROJECTS **************************************************
  // ***********************************************************

  private async _getAllProjects(): Promise<ServiceObject[] | boolean> {
    let response;
    try {
      response = await this._retryAndWaitInCaseOfTooManyRequests(
          superagent
              .get(`${this._workspacesUri}/${this._serviceDefinition.config.workspace?.id}/projects`)
              .auth(this._serviceDefinition.apiKey, 'api_token')
      );
    } catch (ex: any) {
      this.handleResponseException(ex, 'getAllProjects');
      return false;
    }


    const projects: ServiceObject[] = [];

    response.body?.forEach((project: never) => {
      projects.push(
        new ServiceObject(
          project['id'],
          project['name'],
          this._projectsType,
        ));
    });

    return projects;
  }

  private async _createProject(projectName: string): Promise<ServiceObject> {
    const response = await this._retryAndWaitInCaseOfTooManyRequests(
      superagent
        .post(this._projectsUri)
        .auth(this._serviceDefinition.apiKey, 'api_token')
        .send({ project: { name: projectName, is_private: false, wid: this._serviceDefinition.config.workspace?.id } })
    );

    return new ServiceObject(response.body.data['id'], response.body.data['name'], this._projectsType);
  }

  private async _updateProject(objectId: string | number, project: ServiceObject): Promise<ServiceObject> {
    const response = await this._retryAndWaitInCaseOfTooManyRequests(
      superagent
        .put(`${this._projectsUri}/${objectId}`)
        .auth(this._serviceDefinition.apiKey, 'api_token')
        .send({ project: { name: this.getFullNameForServiceObject(project) } })
    );

    return new ServiceObject(response.body.data['id'], response.body.data['name'], this._projectsType);
  }

  private async _deleteProject(id: string | number): Promise<boolean> {
    const response = await this._retryAndWaitInCaseOfTooManyRequests(
      superagent
        .delete(`${this._projectsUri}/${id}`)
        .auth(this._serviceDefinition.apiKey, 'api_token')
    );

    return response.ok;
  }

  // ***********************************************************
  // TAGS ******************************************************
  // ***********************************************************

  private async _getAllTags(): Promise<ServiceObject[] | boolean> {
    let response;

    try {
      response = await this._retryAndWaitInCaseOfTooManyRequests(
          superagent
              .get(`${this._workspacesUri}/${this._serviceDefinition.config.workspace?.id}/tags`)
              .auth(this._serviceDefinition.apiKey, 'api_token')
      );
    } catch (ex: any) {
      this.handleResponseException(ex, 'getAllTags');
      return false;
    }


    const tags: ServiceObject[] = [];

    response.body?.forEach((tag: never) => {
      tags.push(
        new ServiceObject(
          tag['id'],
          tag['name'],
          this._tagsType,
        ));
    });

    return tags;
  }

  /**
   * Real object's name's format: if issue: '#[issueId] [issueName] (issue)'
   * Else '[objectName] ([objectType])'
   * @param objectId id of real object in the primary service
   * @param objectName name of real object in the primary service
   * @param objectType issue, time entry activity, etc.
   */
  private async _createTag(objectId: number, objectName: string, objectType: string): Promise<ServiceObject> {
    const response = await this._retryAndWaitInCaseOfTooManyRequests(
      superagent
        .post(this._tagsUri)
        .auth(this._serviceDefinition.apiKey, 'api_token')
        .send({ tag: { name: this.getFullNameForServiceObject(new ServiceObject(objectId, objectName, objectType)), wid: this._serviceDefinition.config.workspace?.id } })
    );

    return new ServiceObject(response.body.data['id'], response.body.data['name'], this._tagsType);
  }

  private async _updateTag(objectId: number | string, serviceObject: ServiceObject): Promise<ServiceObject> {
    const response = await this._retryAndWaitInCaseOfTooManyRequests(
      superagent
        .put(`${this._tagsUri}/${objectId}`)
        .auth(this._serviceDefinition.apiKey, 'api_token')
        .send({ tag: { name: this.getFullNameForServiceObject(serviceObject) } })
    );

    return new ServiceObject(response.body.data['id'], response.body.data['name'], this._tagsType);
  }

  private async _deleteTag(id: string | number): Promise<boolean> {
    const response = await this._retryAndWaitInCaseOfTooManyRequests(
      superagent
        .delete(`${this._tagsUri}/${id}`)
        .auth(this._serviceDefinition.apiKey, 'api_token')
    );

    return response.ok;
  }

  // ***********************************************************
  // TIME ENTRIES **********************************************
  // ***********************************************************

  async getTimeEntries(start?: Date): Promise<TimeEntry[]> {
    let totalCount = 0;

    const queryParams = {
      since: start?.toISOString(),
      workspace_id: this._serviceDefinition.config.workspace?.id,
      user_ids: this._serviceDefinition.config.userId,
      user_agent: 'Timer2Ticket',
      page: 0,
    };

    const entries: TogglTimeEntry[] = [];

    // time entries via reports (paginate)
    do {
      queryParams.page++;

      let response;

      try {
        response = await this._retryAndWaitInCaseOfTooManyRequests(
            superagent
                .get(this._reportsUri)
                .query(queryParams)
                .auth(this._serviceDefinition.apiKey, 'api_token')
        );
      } catch (ex: any) {
        this.handleResponseException(ex, 'getTimeEntries')
        return [];
      }


      response.body?.data.forEach((timeEntry: never) => {
        entries.push(
          new TogglTimeEntry(
            timeEntry['id'],
            timeEntry['pid'],
            timeEntry['description'],
            new Date(timeEntry['start']),
            new Date(timeEntry['end']),
            timeEntry['dur'],
            timeEntry['tags'],
            new Date(timeEntry['updated']),
          ),
        );
      });

      totalCount = response.body?.total_count;
    } while (queryParams.page * this._responseLimit < totalCount);

    return entries;
  }

  async getTimeEntryById(id: number | string, start?: Date): Promise<TimeEntry | null> {
    const queryParams = {
      time_entry_ids: id,
      since: start?.toISOString(),
      workspace_id: this._serviceDefinition.config.workspace?.id,
      user_ids: this._serviceDefinition.config.userId,
      user_agent: 'Timer2Ticket',
      page: 0,
    };

    const entries: TogglTimeEntry[] = [];

    // time entries via reports (requesting only one object => do not paginate)

    let response;

    try {
      response = await this._retryAndWaitInCaseOfTooManyRequests(
          superagent
              .get(this._reportsUri)
              .query(queryParams)
              .auth(this._serviceDefinition.apiKey, 'api_token')
      );
    } catch (ex: any) {
      this.handleResponseException(ex, 'getTimeEntryById');
      return null;
    }


    response.body?.data.forEach((timeEntry: never) => {
      entries.push(
        new TogglTimeEntry(
          timeEntry['id'],
          timeEntry['pid'],
          timeEntry['description'],
          new Date(timeEntry['start']),
          new Date(timeEntry['end']),
          timeEntry['dur'],
          timeEntry['tags'],
          new Date(timeEntry['updated']),
        ),
      );
    });

    return entries.length === 1 ? entries[0] : null;
  }

  async createTimeEntry(durationInMilliseconds: number, start: Date, end: Date, text: string, additionalData: ServiceObject[]): Promise<TimeEntry | null> {
    let projectId;
    const tags: string[] = [];

    for (const data of additionalData) {
      if (data.type === this._projectsType) {
        projectId = data.id;
      } else {
        tags.push(data.name);
      }
    }

    if (!projectId) {
      // projectId is required
      return null;
    }

    const timeEntryBody: Record<string, unknown> = {
      duration: durationInMilliseconds / 1000,
      start: start.toISOString(),
      end: end.toISOString(),
      pid: projectId,
      duronly: true,
      description: text,
      tags: tags,
      created_with: 'Timer2Ticket',
    };

    const response = await this._retryAndWaitInCaseOfTooManyRequests(
      superagent
        .post(this._timeEntriesUri)
        .auth(this._serviceDefinition.apiKey, 'api_token')
        .send({ time_entry: timeEntryBody })
    );

    if (!response.ok) {
      return null;
    }

    return new TogglTimeEntry(
      response.body.data['id'],
      response.body.data['pid'],
      response.body.data['description'],
      new Date(response.body.data['start']),
      new Date(response.body.data['stop']),
      response.body.data['duration'] * 1000,
      response.body.data['tags'],
      new Date(response.body.data['at']),
    );
  }

  async deleteTimeEntry(id: string | number): Promise<boolean> {
    const response = await this._retryAndWaitInCaseOfTooManyRequests(
      superagent
        .delete(`${this._timeEntriesUri}/${id}`)
        .auth(this._serviceDefinition.apiKey, 'api_token')
    );

    return response.ok;
  }

  /**
   * Extracts project from timeEntry.project + issue and time entry activity etc from the tags
   * @param timeEntry 
   * @param mappings 
   */
  extractMappingsObjectsFromTimeEntry(timeEntry: TimeEntry, mappings: Mapping[]): MappingsObject[] {
    // this should not happen
    if (!(timeEntry instanceof TogglTimeEntry)) return [];

    const mappingsObjectsResult: MappingsObject[] = [];
    for (const mapping of mappings) {
      // ===  'TogglTrack' (is stored in this._serviceDefinition.name)
      const togglMappingsObject = mapping.mappingsObjects.find(mappingsObject => mappingsObject.service === this._serviceDefinition.name);

      if (togglMappingsObject) {
        // find project's mapping - should have same id as timeEntry.projectId
        if (togglMappingsObject.id === timeEntry.projectId && togglMappingsObject.type === this._projectsType) {
          const otherProjectMappingsObjects = mapping.mappingsObjects.filter(mappingsObject => mappingsObject.service !== this._serviceDefinition.name);
          // push to result all other than 'TogglTrack'
          mappingsObjectsResult.push(...otherProjectMappingsObjects);
        } else if (togglMappingsObject.type !== this._projectsType && timeEntry.tags) {
          // find other mappings in timeEntry's tags -> issues, time entry activity
          if (timeEntry.tags.find(tag => tag === togglMappingsObject.name)) {
            const otherProjectMappingsObjects = mapping.mappingsObjects.filter(mappingsObject => mappingsObject.service !== this._serviceDefinition.name);
            // push to result all other than 'TogglTrack'
            mappingsObjectsResult.push(...otherProjectMappingsObjects);
          }
        }
      }
    }
    return mappingsObjectsResult;
  }

  getTimeEntriesRelatedToMappingObjectForUser(mapping: Mapping, user: User): Promise<TimeEntry[] | null> {
    throw 'getTimeEntriesRelatedToMappingObject is not supported on Toggl service!'
  }

  handleResponseException(ex: any, functionInfo: string): void {
    const scope = new Sentry.Scope();
    scope.setTag("Service", "Toggl");
    scope.setContext("Service url", {url: this._timeEntriesUri})
    scope.setContext("Exception", ex);
    if (ex != undefined && (ex.status === 403 || ex.status === 401) ) {
      scope.setContext("Status code", ex.status);
      Sentry.captureException(''.concat(functionInfo, ' failed with status code=', ex.status, '\nplease, fix the apiKey of this user or set him as inactive'), scope);
      // console.error('[TOGGL] '.concat(functionInfo, ' failed with status code=', ex.status));
      // console.log('please, fix the apiKey of this user or set him as inactive');
      //TODO: save errors
    } else {
      //TODO: save errors
      Sentry.captureException(' '.concat(functionInfo, ' failed with different reason than 403/401 response code!'));
      // console.error('[REDMINE] '.concat(functionInfo, ' failed with different reason than 403/401 response code!'));
    }
  }
}
