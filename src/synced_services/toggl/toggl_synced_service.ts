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
import {Timer2TicketError} from "../../models/timer2TicketError";
import {SentryService} from "../../shared/sentry_service";
import {ErrorService} from "../../shared/error_service";
import {ServiceTimeEntryObject} from "../../models/synced_service/time_entry_synced_object/service_time_entry_object";
import {Utilities} from "../../shared/utilities";
import {ExtraContext} from "../../models/extra_context";
import {T2tErrorExtraContext} from "../../models/t2t_error_extra_context";

export class TogglTrackSyncedService implements SyncedService {
  private _serviceDefinition: ServiceDefinition;

  private _baseUri: string;
  private _userUri: string;
  private _workspacesUri: string;
  private _workspacesTimeEntriesUri: string;
  private _meTimeEntriesUri: string;
  private _projectsUri: string;
  private _tagsUri: string;
  private _reportsSearchTimeEntryUri: string;
  private _projectsType: string;
  private _tagsType: string;

  private _responseLimit: number;
  public errors: Array<Timer2TicketError>;
  readonly _sentryService: SentryService
  readonly _errorService: ErrorService
  readonly _user: User | null;

  readonly supportsBackwardTagAssignmentAsSource = true;
  readonly supportsBackwardTagAssignmentAsTarget = false;

  constructor(serviceDefinition: ServiceDefinition) {
    this._serviceDefinition = serviceDefinition;

    this._baseUri = 'https://api.track.toggl.com/';
    this._userUri = `${this._baseUri}api/v9/me`;
    this._workspacesUri = `${this._baseUri}api/v9/workspaces`;
    this._workspacesTimeEntriesUri = `${this._workspacesUri}/${this._serviceDefinition.config.workspace?.id}/time_entries`;
    this._meTimeEntriesUri = `${this._userUri}/time_entries`;
    this._projectsUri = `${this._workspacesUri}/${this._serviceDefinition.config.workspace?.id}/projects`;
    this._tagsUri = `${this._workspacesUri}/${this._serviceDefinition.config.workspace?.id}/tags`;
    this._reportsSearchTimeEntryUri = `${this._baseUri}reports/api/v3/workspace/${this._serviceDefinition.config.workspace?.id}/search/time_entries`;

    this._projectsType = 'project';
    this._tagsType = 'tag';

    // defined by Toggl, cannot override
    this._responseLimit = 50;

    this.errors = [];

    this._sentryService = new SentryService();
    this._errorService = new ErrorService();

    //not used in this synced service
    this._user = null;
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
   * @param extraContext
   * @returns Promise<superagent.Response>
   * @throws any
   */
  private async _retryAndWaitInCaseOfTooManyRequests(request: SuperAgentRequest, extraContext: T2tErrorExtraContext): Promise<superagent.Response> {
    let needToWait = false;

    // call request but with chained retry
    const res = await request
        .timeout(5000)
        .retry(2, (err, res) => {

          if (res && res.status === 429) {
            // cannot wait here, since it cannot be async method (well it can, but it does not wait)
            needToWait = true;
          }
        })
        .catch(err => {
          this.handleResponseException(err, extraContext)
          return err;
        });


    if (needToWait) {
      // wait, because Toggl is responding with 429
      await this._wait();
    }

    if ((!res.response && !res.ok) || (res.response && !res.response.ok)) {
      throw res;
    }
    return res;
  }

  async getAllServiceObjects(lastSyncAt: number | null): Promise<ServiceObject[] | boolean> {
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

  async deleteServiceObject(id: string | number, objectType: string, name: string): Promise<boolean> {
    switch (objectType) {
      case this._projectsType:
        return await this._deleteProject(id, name);
      default:
        return await this._deleteTag(id, name);
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
    const projects: ServiceObject[] = [];
    let response;

    const queryParams = {
      page: 1,
      per_page: 200,
    };

    do {
      try {
        response = await this._retryAndWaitInCaseOfTooManyRequests(
            superagent
                .get(this._projectsUri)
                .auth(this._serviceDefinition.apiKey, 'api_token')
                .query(queryParams),
            new T2tErrorExtraContext(this._serviceDefinition.name, 'getAllProjects')
        );
      } catch (ex: any) {
        return false;
      }

      response.body?.forEach((project: never) => {
        projects.push(
            new ServiceObject(
                project['id'],
                project['name'],
                this._projectsType,
            ));
      });
      queryParams.page += 1;
    } while (response.body?.length > 0)

    return projects;
  }

  private async _createProject(projectName: string): Promise<ServiceObject> {
    const body = { name: projectName, is_private: false, active: true };
    const response = await this._retryAndWaitInCaseOfTooManyRequests(
        superagent
            .post(this._projectsUri)
            .auth(this._serviceDefinition.apiKey, 'api_token')
            .send(body),
        new T2tErrorExtraContext(this._serviceDefinition.name, 'createProject', null, [body.name])
    );

    return new ServiceObject(response.body['id'], response.body['name'], this._projectsType);
  }

  private async _updateProject(objectId: string | number, project: ServiceObject): Promise<ServiceObject> {
    const body = { name: this.getFullNameForServiceObject(project), active: true };
    const response = await this._retryAndWaitInCaseOfTooManyRequests(
        superagent
            .put(`${this._projectsUri}/${objectId}`)
            .auth(this._serviceDefinition.apiKey, 'api_token')
            .send(body),
        new T2tErrorExtraContext(this._serviceDefinition.name, 'updateProject', objectId.toString(), [body.name])
    );

    return new ServiceObject(response.body['id'], response.body['name'], this._projectsType);
  }

  private async _deleteProject(id: string | number, name: string): Promise<boolean> {
    const response = await this._retryAndWaitInCaseOfTooManyRequests(
        superagent
            .delete(`${this._projectsUri}/${id}`)
            .auth(this._serviceDefinition.apiKey, 'api_token'),
        new T2tErrorExtraContext(this._serviceDefinition.name, 'deleteProject', id.toString(), [name])
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
              .get(this._tagsUri)
              .auth(this._serviceDefinition.apiKey, 'api_token'),
          new T2tErrorExtraContext(this._serviceDefinition.name, 'getAllTags')
      );
    } catch (ex: any) {
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
    const body = {
      name: this.getFullNameForServiceObject(new ServiceObject(objectId, objectName, objectType)),
      workspace_id: this._serviceDefinition.config.workspace?.id
    };
    const response = await this._retryAndWaitInCaseOfTooManyRequests(
        superagent
            .post(this._tagsUri)
            .auth(this._serviceDefinition.apiKey, 'api_token')
            .send(body),
        new T2tErrorExtraContext(this._serviceDefinition.name, 'createTag', null, [body.name])
    );

    return new ServiceObject(response.body['id'], response.body['name'], this._tagsType);
  }

  private async _updateTag(objectId: number | string, serviceObject: ServiceObject): Promise<ServiceObject> {
    const body = { name: this.getFullNameForServiceObject(serviceObject) };
    const response = await this._retryAndWaitInCaseOfTooManyRequests(
        superagent
            .put(`${this._tagsUri}/${objectId}`)
            .auth(this._serviceDefinition.apiKey, 'api_token')
            .send(body),
        new T2tErrorExtraContext(this._serviceDefinition.name, 'updateTag', objectId.toString(), [body.name])
    );

    return new ServiceObject(response.body['id'], response.body['name'], this._tagsType);
  }

  private async _deleteTag(id: string | number, name: string): Promise<boolean> {
    const response = await this._retryAndWaitInCaseOfTooManyRequests(
        superagent
            .delete(`${this._tagsUri}/${id}`)
            .auth(this._serviceDefinition.apiKey, 'api_token'),
        new T2tErrorExtraContext(this._serviceDefinition.name, 'deleteTag', id.toString(), [name])
    );

    return response.ok;
  }

  // ***********************************************************
  // TIME ENTRIES **********************************************
  // ***********************************************************

  async getTimeEntries(start?: Date): Promise<TimeEntry[]> {
    const end = new Date();
    end.setFullYear(9999);

    const queryParams = {
      start_date: start?.toISOString(),
      end_date: end?.toISOString(),
    };

    const entries: TogglTimeEntry[] = [];

    const response = await this._retryAndWaitInCaseOfTooManyRequests(
        superagent
            .get(this._meTimeEntriesUri)
            .query(queryParams)
            .auth(this._serviceDefinition.apiKey, 'api_token'),
        new T2tErrorExtraContext(this._serviceDefinition.name, 'getTimeEntries')
    );

    response.body?.forEach((timeEntry: never) => {
      if(timeEntry['workspace_id'] === this._serviceDefinition.config.workspace?.id && timeEntry['duration'] >= 0) {
        entries.push(
            new TogglTimeEntry(
                timeEntry['id'],
                timeEntry['project_id'],
                timeEntry['description'],
                new Date(timeEntry['start']),
                new Date(timeEntry['stop']),
                timeEntry['duration'] * 1000,
                timeEntry['tags'],
                new Date(timeEntry['at']),
                timeEntry
            ),
        );
      }
    });

    return entries;
  }


  async replaceTimeEntryDescription(timeEntry: ServiceTimeEntryObject, tagName: number | string) : Promise<void> {
    const start = new Date();
    start.setMonth(start.getMonth() - 6);
    const timeEntryFromApi = await this.getTimeEntryById(timeEntry.id, start);

    if (timeEntryFromApi === null || timeEntryFromApi.text.includes(tagName.toString())) {
      return;
    }

    const body =
      [
        {'op': 'replace',
          'path': '/description',
          'value': timeEntryFromApi?.text + ` ${tagName}`
        }
      ]
    ;

    const teStart = new Date(timeEntryFromApi.start).toISOString();
    await this._retryAndWaitInCaseOfTooManyRequests(
        superagent
            .patch(`${this._workspacesTimeEntriesUri}/${timeEntry?.id}`)
            .auth(this._serviceDefinition.apiKey, 'api_token')
            .send(body),
        new T2tErrorExtraContext(this._serviceDefinition.name, 'replaceTimeEntryDescription', timeEntry.id.toString(), ["TE start date: " + teStart])
    );
  }

  async getTimeEntryById(id: number | string, start?: Date): Promise<TimeEntry | null> {
    const end = new Date(start!);
    end.setDate(end.getDate() + 364); // Max time range is 365 days

    const queryParams = {
      time_entry_ids: [id],
      start_date: start?.toISOString().slice(0, 10), // format YYYY-MM-DD
      end_date: end.toISOString().slice(0, 10), // format YYYY-MM-DD
    };

    const entries: TogglTimeEntry[] = [];

    const response = await this._retryAndWaitInCaseOfTooManyRequests(
        superagent
            .post(this._reportsSearchTimeEntryUri)
            .auth(this._serviceDefinition.apiKey, 'api_token')
            .send(queryParams),
        new T2tErrorExtraContext(this._serviceDefinition.name, 'getTimeEntryById', id.toString())
    );

    const allTags: ServiceObject[] = await this._getAllTags() as ServiceObject[];

    response.body.forEach((timeEntryInfo: never) => {
      const timeEntries: never[] = timeEntryInfo['time_entries'];
      if (!timeEntries || timeEntries.length === 0) {
        return null;
      }
      const timeEntry = timeEntries[0];

      const timeEntryIds: number[] = (timeEntryInfo['tag_ids']);

      const tags: string[] = [];
      timeEntryIds.forEach((tagId: number) => {
        const foundTag = allTags.find((t) => t.id === tagId);
        if (foundTag) {
          tags.push(foundTag.name);
        }
      });

      const entry = new TogglTimeEntry(
          timeEntry['id'],
          timeEntryInfo['project_id'],
          timeEntryInfo['description'],
          new Date(timeEntry['start']),
          new Date(timeEntry['stop']),
          timeEntry['seconds'] * 1000,
          tags,
          new Date(timeEntry['at']),
          timeEntry
      );

      entries.push(entry);
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
      wid: this._serviceDefinition.config.workspace?.id,
    };

    const response = await this._retryAndWaitInCaseOfTooManyRequests(
        superagent
            .post(this._workspacesTimeEntriesUri)
            .auth(this._serviceDefinition.apiKey, 'api_token')
            .send(timeEntryBody),
        new T2tErrorExtraContext(this._serviceDefinition.name, 'createTimeEntry', null, ["TE start date: " + start.toISOString()])
    );

    if (!response || !response.ok) {
      return null;
    }

    return new TogglTimeEntry(
      response.body['id'],
      response.body['pid'],
      response.body['description'],
      new Date(response.body['start']),
      new Date(response.body['stop']),
      response.body['duration'] * 1000,
      response.body['tags'],
      new Date(response.body['at']),
      response.body
    );
  }

  async updateTimeEntry(
    durationInMilliseconds: number,
    start: Date,
    text: string,
    additionalData: ServiceObject[],
    originalTimeEntry: TogglTimeEntry
  ): Promise<TimeEntry> {
    let projectId;
    const tags: string[] = [];

    for (const data of additionalData) {
      if (data.type === this._projectsType) {
        projectId = data.id;
      } else {
        tags.push(data.name);
      }
    }

    const originalEntry = new TogglTimeEntry(
        originalTimeEntry.id,
        originalTimeEntry.projectId,
        originalTimeEntry.text,
        originalTimeEntry.start,
        originalTimeEntry.end,
        originalTimeEntry.durationInMilliseconds,
        originalTimeEntry.tags,
        originalTimeEntry.lastUpdated,
        null,
    )

    delete originalTimeEntry.originalEntry['tag_ids'];

    //project id
    if (projectId && projectId !== originalTimeEntry.projectId) {
      //what about the case when project id is null on either side?
      originalTimeEntry.originalEntry['project_id'] = projectId;
    }

    //comment
    if (text != originalTimeEntry.text) {
      originalTimeEntry.originalEntry['description'] = text;
    }

    //spent on
    const originalDate = new Date(originalTimeEntry.start);
    const startDate = new Date(start);
    originalDate.setHours(0, 0, 0, 0);
    startDate.setHours(0, 0, 0, 0);
    if (Utilities.compare(startDate, originalDate)) {
      originalTimeEntry.originalEntry['start_date'] = Utilities.getOnlyDateString(start);
    }

    //duration
    if (durationInMilliseconds != originalTimeEntry.durationInMilliseconds) {
      originalTimeEntry.originalEntry['duration'] = Math.round(durationInMilliseconds / 1000)
      delete originalTimeEntry.originalEntry['stop'];
    }

    //tags
   if (new Set(tags) !== new Set(originalTimeEntry.tags)) {
     originalTimeEntry.originalEntry['tags'] = tags;
   }

    try {
      const teStart = new Date(originalTimeEntry.start);
      const response = await this._retryAndWaitInCaseOfTooManyRequests(
          superagent
              .put(`${this._workspacesTimeEntriesUri}/${originalTimeEntry.id}`)
              .auth(this._serviceDefinition.apiKey, 'api_token')
              .send(originalTimeEntry.originalEntry),
          new T2tErrorExtraContext(this._serviceDefinition.name, 'updateTimeEntry', originalTimeEntry.id.toString(), ["TE start date: " + teStart.toISOString()])
      );

      return new TogglTimeEntry(
          response.body['id'],
          response.body['pid'],
          response.body['description'],
          new Date(response.body['start']),
          new Date(response.body['stop']),
          response.body['duration'] * 1000,
          response.body['tags'],
          new Date(response.body['at']),
          response.body
      );
    } catch (error) {
      return originalEntry;
    }
  }

  async deleteTimeEntry(id: string | number): Promise<boolean> {
    const response = await this._retryAndWaitInCaseOfTooManyRequests(
        superagent
            .delete(`${this._workspacesTimeEntriesUri}/${id}`)
            .auth(this._serviceDefinition.apiKey, 'api_token'),
        new T2tErrorExtraContext(this._serviceDefinition.name, 'deleteTimeEntry', id.toString())
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

  handleResponseException(ex: any, extraContext: T2tErrorExtraContext): void {
    let context: ExtraContext[] = [];
    if (ex != undefined) {
      context = [
        this._sentryService.createExtraContext("Exception", ex),
        this._sentryService.createExtraContext("Response", ex.response),
      ]
      if (extraContext) {
        context.push(this._sentryService.createExtraContext("Extra_context", JSON.parse(JSON.stringify(extraContext))));
      }
    }

    const error = this._errorService.createTogglError(ex?.response?.error ?? ex);

    if (ex.response && (ex.response.statusCode === 401 || ex.response.statusCode === 403)) {
      error.specification += " - API key error";
      error.data = undefined;

    } else if (ex.response) {
      const message = `${extraContext.functionName} failed with a response code ${ex.response.statusCode}`;
      error.specification += " - " + message;
      error.data = extraContext;
      error.data.responseErrors = !ex.response.text ? [ex.response.statusCode] : [ex.response.text, ex.response.statusCode];

      this._sentryService.logTogglError(message, context);
    } else {
      const message = `${extraContext.functionName} failed without a response`;
      error.specification += " - " + message;
      extraContext.responseErrors = [ex.message];
      error.data = extraContext;

      this._sentryService.logTogglError(message, context);
    }

    this.errors.push(error);
  }

  getAllRemovableObjectsWithinDate(startAt: Date | null, endAt: Date | null): Promise<ServiceObject[] | boolean> {
    throw new Error("Toggle is secondary service - This functions should not be implemented.");
  }

  getServiceObjects(ids: (string | number)[]): Promise<ServiceObject[]> {
    throw new Error("Toggle is secondary service - This functions should not be implemented.");
  }

  public getServiceDefinition(): ServiceDefinition {
    return this._serviceDefinition;
  }
}
