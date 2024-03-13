import { IssueState } from "../../models/connection/config/issue_state";
import { SyncedServiceDefinition } from "../../models/connection/config/synced_service_definition";
import { WebhookEventData } from "../../models/connection/config/webhook_event_data";
import { Connection } from "../../models/connection/connection";
import { Mapping } from "../../models/connection/mapping/mapping";
import { MappingsObject } from "../../models/connection/mapping/mappings_object";
import { ServiceObject } from "../../models/synced_service/service_object/service_object";
import { JiraTimeEntry } from "../../models/synced_service/time_entry/jira_time_entry";
import { TimeEntry } from "../../models/synced_service/time_entry/time_entry";
import { Timer2TicketError } from "../../models/timer2TicketError";
import { ErrorService } from "../../shared/error_service";
import { SentryService } from "../../shared/sentry_service";
import { SyncedService } from "../synced_service";
import superagent, { SuperAgentRequest } from "superagent";

export class jiraSyncedService implements SyncedService {


    private _domain: string
    private _apiKey: string
    private _userEmail: string
    private _secret: string
    private _hasFallbackIssue: boolean
    private _fallbackIssueName: string | null
    private _ignoreIssueStates: IssueState[]


    private _issueUri: string
    private _projectUri: string
    private _searchUri: string
    private _projectsType: string
    private _issuesType: string
    private _maxResultsPerSearch: number
    private _serviceName: string



    errors: Array<Timer2TicketError>;
    readonly _sentryService: SentryService
    readonly _errorService: ErrorService

    constructor(syncedServiceDefinition: SyncedServiceDefinition) {
        this._domain = syncedServiceDefinition.config.domain!
        this._apiKey = syncedServiceDefinition.config.apiKey
        this._userEmail = syncedServiceDefinition.config.userEmail!
        this._serviceName = syncedServiceDefinition.name
        this._secret = Buffer.from(`${this._userEmail}:${this._apiKey}`).toString("base64")
        this._hasFallbackIssue = syncedServiceDefinition.config.fallbackIssue!.fallbackIssue
        this._hasFallbackIssue ?
            this._fallbackIssueName = syncedServiceDefinition.config.fallbackIssue!.name
            : this._fallbackIssueName = null
        this._ignoreIssueStates = syncedServiceDefinition.config.ignoredIssueStates

        this._issueUri = `${this._domain}rest/api/3/issue`
        this._projectUri = `${this._domain}rest/api/3/project`
        this._searchUri = `${this._domain}rest/api/3/search`
        this._projectsType = 'project'
        this._issuesType = 'issue'
        this._maxResultsPerSearch = 50

        this.errors = []
        this._sentryService = new SentryService()
        this._errorService = new ErrorService()
    }

    /**
   * Get all service objects which: projects, issues (with the right state), activities etc.
   * returns false in case of any error
   */
    async getAllServiceObjects(syncCustomField: string | number | null = null): Promise<ServiceObject[] | boolean> {
        const allServiceObjects: ServiceObject[] = []
        const projects = await this._getAllProjects()
        allServiceObjects.push(...projects)

        const issues = await this._getIssues(projects, syncCustomField)
        if (issues.length >= 1 && projects.length === 0)
            return false
        allServiceObjects.push(...issues)

        return allServiceObjects
    }

    private async _getAllProjects(): Promise<ServiceObject[]> {
        let response
        try {
            response = await superagent
                .get(this._projectUri)
                .set('Authorization', `Basic ${this._secret}`)
            //.accept('application/json')
            //.type('application/json')
        } catch (ex: any) {
            this.handleResponseException(ex, 'Get jira projects', this._projectUri)
            return []
        }
        const projects: ServiceObject[] = []
        response.body?.forEach((project: any) => {
            projects.push(
                new ServiceObject(project.id, project.name, this._projectsType)
            )
        })
        return projects
    }

    private async _getIssues(projects: ServiceObject[], syncCustomField: string | number | null): Promise<ServiceObject[]> {
        const issues: ServiceObject[] = []
        for (const project of projects) {
            const issuesOfProject = await this._getIssuesOfProject(project.id, true, syncCustomField)
            issues.push(...issuesOfProject)
        }
        return issues
    }



    private async _getIssuesOfProject(projectIdOrKey: string | number, selectByState: boolean, syncCustomField: string | number | null, start?: Date, end?: Date): Promise<ServiceObject[]> {
        const issues: ServiceObject[] = []
        let total = 1
        let received = 0
        while (total > received) {
            const query = this._generateQueryForGettingAllIssues(projectIdOrKey, selectByState, start, end)
            let response
            try {
                response = await superagent
                    .get(`${this._searchUri}?${query}`)
                    .set('Authorization', `Basic ${this._secret}`)
                    .query({ jql: query, startAt: received })
                    .accept('application/json')
            } catch (ex: any) {
                this.handleResponseException(ex, `Get all issues of project ${projectIdOrKey}`, `${this._searchUri}?${query}`)
                return []
            }
            total = response.body.total
            const responseIssues = response.body.issues
            responseIssues.forEach((issue: any) => {
                received++
                const custFieldValue = syncCustomField ? issue.fields[syncCustomField] : null
                issues.push(new ServiceObject(issue.id, issue.fields.summary, this._issuesType, issue.fields.project.id, custFieldValue))
            })
        }
        return issues
    }

    private _generateQueryForGettingAllIssues(projectIdOrKey: string | number, selectByState: boolean, start?: Date, end?: Date): string {
        let query = `project=${projectIdOrKey}`
        if (start) {
            query += ` AND worklogDate>="${start.getFullYear()}/${start.getMonth() + 1}/${start.getDate()}"`
            if (end) {
                query += `AND worklogDate<="${end.getFullYear()}/${end.getMonth() + 1}/${end.getDate()}"`
            }
        }
        if (selectByState) {
            for (const ignoredState of this._ignoreIssueStates) {
                query += ` AND statusCategory != ${ignoredState.id}`
            }
        }
        return query
    }

    /**
     * Create service object like project, issue, tag and activity in the service, and return newly created one
     * 
     * Typically created with name '[objectName] ([objectType])' or '#[objectId] [objectName] ([objectType])'
     * @param objectId id of serviceObject in the primary service => needed to generate name with that id
     * @param objectName name of serviceObject
     * @param objectType type of serviceObject, ('tag', ...)
     */
    async createServiceObject(objectId: string | number, objectName: string, objectType: string): Promise<ServiceObject> {
        switch (objectType) {
            case this._issuesType:
                throw new Error('Creating issues in Jira is not supported')
            default:
                throw new Error(`Creating Service object types of ${objectType} is not allowed in Jira`)
        }
    }

    /**
     * Update service object like project, issue, tag and activity in the service, and return updated one
     * Used generally to update the object's name
     * Typically with name '[objectName] ([objectType])'
     * @param objectId id of object to update
     * @param serviceObject serviceObject based on real object in primary service to extract name and possibly type for
     */
    updateServiceObject(objectId: string | number, serviceObject: ServiceObject): Promise<ServiceObject> {
        throw new Error('Updating Service objects in Jira is not allowed')
    }

    deleteServiceObject(id: string | number, objectType: string): Promise<boolean> {
        throw new Error('Deleting Service objects in Jira is not allowed')
    }

    /**
     * Generates full name for given service object (Toggl, for example, generates names for tags as 'name (type)' or if issue, then '#id name (type)')
     * @param serviceObject 
     */
    getFullNameForServiceObject(serviceObject: ServiceObject): string {
        return serviceObject.name
    }

    /**
     * getTimeEntries
     * returnes only time entries with some worklog logged after @start and before @end
     */
    async getTimeEntries(start?: Date, end?: Date): Promise<TimeEntry[]> {
        const timeEntries: JiraTimeEntry[] = []

        const projects = await this._getAllProjects()
        for (const project of projects) {
            const issues = await this._getIssuesOfProject(project.id, false, null, start, end)
            for (const issue of issues) {
                let response
                try {
                    response = await superagent
                        .get(`${this._issueUri}/${issue.id}/worklog`)
                        .set('Authorization', `Basic ${this._secret}`)
                        .accept('application/json')
                } catch (ex: any) {
                    this.handleResponseException(ex, `getting all TEs`, `${this._issueUri}/${issue.id}/worklog`)
                    continue
                }
                if (response.body.total > 0 && response.body.worklogs) {
                    const worklogs = response.body.worklogs
                    worklogs.forEach((worklog: any) => {
                        const durationInMilliseconds = worklog.timeSpentSeconds * 1000
                        const teStart = new Date(worklog.started)

                        timeEntries.push(new JiraTimeEntry(
                            this._createTimeEntryId(issue.id, worklog.id),
                            project.id,
                            this._getcommentOfWorklog(worklog),
                            teStart,
                            this._calculateEndfromStartAndDuration(teStart, durationInMilliseconds),
                            durationInMilliseconds,
                            new Date(worklog.updated),
                        ))
                    })
                }
            }
        }
        return timeEntries
    }

    /**
     * Returns only one time entry based on given id
     */
    async getTimeEntryById(id: number | string, start?: Date): Promise<TimeEntry | null> {
        const issueId = this._issueIdFromTimeEntryId(id)
        const worklogId = this._worklogIdFromTimeEntryId(id)
        let response
        try {
            response = await superagent
                .get(`${this._issueUri}/${issueId}`)
                .set('Authorization', `Basic ${this._secret}`)
                .accept('application/json')
        } catch (ex: any) {
            this.handleResponseException(ex, `gettnig TE with id ${id}`, `${this._issueUri}/${issueId}`)
            return null
        }
        if (!response || !response.ok || response.body.fields.worklog.total === 0) {
            return null
        }
        const worklogs = response.body.fields.worklog.worklogs
        const myWorklog = worklogs.find((w: any) => w.id == worklogId)
        if (!myWorklog) {
            return null

        }

        const durationInMilliseconds = myWorklog.timeSpentSeconds * 1000
        const teStart = new Date(myWorklog.started)

        return new JiraTimeEntry(
            id,
            response.body.fields.project.id,
            this._getcommentOfWorklog(myWorklog),
            teStart,
            this._calculateEndfromStartAndDuration(teStart, durationInMilliseconds),
            durationInMilliseconds,
            new Date(myWorklog.updated)
        )
    }

    /**
     * Create a new time entry real object in the service, returns specific TimeEntry
     * @param durationInMilliseconds 
     * @param start 
     * @param end 
     * @param text 
     * @param additionalData 
     */
    async createTimeEntry(durationInMilliseconds: number, start: Date, end: Date, text: string, additionalData: ServiceObject[]): Promise<TimeEntry | null> {
        let projectId
        let issueId
        for (const data of additionalData) {
            if (data.type === this._projectsType) {
                projectId = data.id!
            } else if (data.type === this._issuesType) {
                issueId = data.id!
            }
        }
        if (!issueId && !projectId) {
            //at least one is needed to succesfully create TE in Jira
            return null
        }

        //date format in iso string was not working. expts ending with +000 instead of Z
        let modifiedStart = start.toISOString()
        modifiedStart = modifiedStart.slice(0, modifiedStart.length - 1)
        modifiedStart += '+0000'

        const data = {
            "comment": {
                "content": [
                    {
                        "content": [
                            {
                                "text": text,
                                "type": "text"
                            }
                        ],
                        "type": "paragraph"
                    }
                ],
                "type": "doc",
                "version": 1
            },
            "started": modifiedStart,
            "timeSpentSeconds": (Math.floor(durationInMilliseconds / 1000))
        }

        let response
        if (!issueId && projectId) {
            //log to falllback = change ID of issue to log to
            if (!this._hasFallbackIssue) {
                //user congifured they do not want to sync such TEs
                return null
            }
            issueId = await this._getIdOfFallbackIssue(projectId)
        }
        try {
            response = await superagent
                .post(`${this._issueUri}/${issueId}/worklog`)
                .set('Authorization', `Basic ${this._secret}`)
                .accept('application/json')
                .send(data)
        } catch (ex: any) {
            this.handleResponseException(ex, `create new TE in Jira`, `${this._issueUri}/${issueId}/worklog`)
            return null
        }
        const teStart = new Date(response.body.started)

        const newTimeEntry = new JiraTimeEntry(
            this._createTimeEntryId(response.body.issueId, response.body.id),
            projectId ? projectId : '',
            text,
            teStart,
            this._calculateEndfromStartAndDuration(teStart, durationInMilliseconds),
            durationInMilliseconds,
            new Date(response.body.updated))
        return newTimeEntry

    }

    /**
     * Delete time entry with given id, returns true if successfully deleted
     * @param id of the time entry to delete from the service
     */
    async deleteTimeEntry(id: string | number): Promise<boolean> {
        const issueId = this._issueIdFromTimeEntryId(id)
        const worklogId = this._worklogIdFromTimeEntryId(id)
        if (issueId === -1 || worklogId === -1)
            return false
        let response
        try {
            response = await superagent
                .delete(`${this._issueUri}/${issueId}/worklog/${worklogId}`)
                .set('Authorization', `Basic ${this._secret}`)
        } catch (ex: any) {
            this.handleResponseException(ex, `deleting TE with id ${id}`, `${this._issueUri}/${issueId}/worklog/${worklogId}`)
            return false
        }
        if (response.status !== 204)
            return false
        return true
    }

    /**
     * Extracts config objects from specific timeEntry other than Jira
     * @param timeEntry timeEntry object from which mappingsObjects are extracting - each specific manager has its specific time entry instance (e.g. JiraTimeEntry)
     * @param mappings user's mappings where to find mappingsObjects (by id)
     */
    extractMappingsObjectsFromTimeEntry(timeEntry: TimeEntry, mappings: Mapping[]): MappingsObject[] {
        if (!(timeEntry instanceof JiraTimeEntry))
            return []
        const results: MappingsObject[] = []
        for (const mapping of mappings) {
            const jiraObj = mapping.mappingsObjects.find(o => o.service === this._serviceName)
            if (jiraObj) {
                const issueId = this._issueIdFromTimeEntryId(timeEntry.id)
                if ((jiraObj.id == timeEntry.projectId && jiraObj.type === this._projectsType)
                    || (issueId !== -1 && jiraObj.id == issueId && jiraObj.type === this._issuesType)
                ) {
                    const notJiraMappings = mapping.mappingsObjects.filter(o => o.service !== this._serviceName)
                    //push other than Jira
                    results.push(...notJiraMappings)
                }
            }
        }
        return results
    }

    async getTimeEntriesRelatedToMappingObjectForConnection(mapping: Mapping, connection: Connection): Promise<TimeEntry[] | null> {
        if (mapping.primaryObjectType !== this._issuesType) {
            //there are only issue related TEs in Jira (even the one to project is logged to specific issue)
            return []
        }

        //it is not realy needed for Jira, for redmine it is necessary to get userId
        const jiraServiceDefinition = Connection.findServiceDefinitionByName(this._serviceName, connection)
        //check if the connection exists
        if (jiraServiceDefinition === undefined) {
            return null
        }

        const issueId = mapping.primaryObjectId

        const timeEntries: TimeEntry[] = []
        let response
        try {
            response = await superagent
                .get(`${this._issueUri}/${issueId}`)
                .set('Authorization', `Basic ${this._secret}`)
                .accept('application/json')
        } catch (ex: any) {
            this.handleResponseException(ex, `getting TE related to mapping obj for connection`, `${this._issueUri}/${issueId}`)
            return null
        }
        if (!response || !response.ok)
            return null

        const issue = response.body
        for (const worklog of issue.fields.worklog.worklogs) {
            const start = new Date(worklog.started)
            const durationInMiliseconds = worklog.timeSpentSeconds * 1000
            const timeEntry = new JiraTimeEntry(
                this._createTimeEntryId(issueId, worklog.id),
                issue.fields.project.id,
                this._getcommentOfWorklog(worklog),
                start,
                this._calculateEndfromStartAndDuration(start, durationInMiliseconds),
                durationInMiliseconds,
                new Date(worklog.updated)
            )
            timeEntries.push(timeEntry)
        }
        return timeEntries
    }

    async getIssueIdFromIssueKey(issueKey: string): Promise<number> {
        let response
        try {
            response = await superagent
                .get(`${this._issueUri}/${issueKey}`)
                .set('Authorization', `Basic ${this._secret}`)
                .accept('application/json')
        } catch (ex: any) {
            this.handleResponseException(ex, `getting id of Issue with key ${issueKey} failed`, `${this._issueUri}/`)
            return 0
        }
        return response.body.id
    }

    async getObjectsFromWebhook(webhookObject: WebhookEventData, syncCustomField: string | number | null | undefined): Promise<[ServiceObject, TimeEntry | null] | null> {
        const requestId = webhookObject.type === 'worklog' ? this._issueIdFromTimeEntryId(webhookObject.id) : webhookObject.id
        const type = webhookObject.type === this._projectsType ? this._projectsType : this._issuesType
        const uri = type === this._projectsType ? this._projectUri : this._issueUri
        let response
        try {
            response = await superagent
                .get(`${uri}/${requestId}`)
                .set('Authorization', `Basic ${this._secret}`)
                .accept('application/json')
        } catch (ex: any) {
            //this.handleResponseException(ex, `getting issueOr Project with id ${requestId} failed`, `${uri}/`)
            return null
        }
        let serviceObject
        // console.log(response.body)
        try {
            serviceObject = type === this._projectsType
                ? new ServiceObject(response.body.id, response.body.name, type)
                : new ServiceObject(response.body.id, response.body.fields.summary, type, response.body.fields.project.id, syncCustomField ? response.body.fields[syncCustomField] : null)
        } catch (ex: any) {
            // console.log('failed to build ServiceObject', ex)
            return null
        }
        let timeEntry = null
        if (webhookObject.type === 'worklog') {
            const worklogs = response.body.fields.worklog.worklogs
            const worklogId = this._worklogIdFromTimeEntryId(webhookObject.id)
            const worklog = worklogs.find((w: any) => {
                return w.id == worklogId
            })
            if (!worklog)
                return null
            const start = new Date(worklog.started)
            const durationInMiliseconds = worklog.timeSpentSeconds * 1000
            const text = this._getcommentOfWorklog(worklog)
            timeEntry = new JiraTimeEntry(
                this._createTimeEntryId(response.body.id, worklog.id),
                response.body.fields.project.id,
                text,
                start,
                this._calculateEndfromStartAndDuration(start, durationInMiliseconds),
                durationInMiliseconds,
                new Date(worklog.updated)
            )
        }
        return [serviceObject, timeEntry]
    }

    private _getcommentOfWorklog(worklog: any): string {
        if (worklog.comment && worklog.comment.content[0] && worklog.comment.content[0].content[0] && worklog.comment.content[0].content[0].text) {
            return worklog.comment.content[0].content[0].text
        } else {
            return ''
        }
    }

    private _createTimeEntryId(issueId: number | string, worklogId: number | string): string {
        return `${issueId}_${worklogId}`
    }

    private _issueIdFromTimeEntryId(timeEntryId: string | number): number {
        if (typeof timeEntryId === 'string')
            return Number(timeEntryId.split('_')[0])
        else
            return -1
    }
    private _worklogIdFromTimeEntryId(timeEntryId: string | number): number {
        if (typeof timeEntryId === 'string')
            return Number(timeEntryId.split('_')[1])
        return -1
    }

    private _calculateEndfromStartAndDuration(start: Date, durationInMilliseconds: number): Date {
        return new Date(start.getTime() + durationInMilliseconds)
    }

    private async _getIdOfFallbackIssue(projectId: string | number): Promise<number | string | null> {
        if (!this._fallbackIssueName)
            return null

        let total = 1
        let received = 0
        const issues: any = []
        while (total > received) {
            const query = this._generateSummarySearchQuery(projectId, this._fallbackIssueName)
            let response
            try {
                response = await superagent
                    .get(`${this._searchUri}`)
                    .set('Authorization', `Basic ${this._secret}`)
                    .query({ 'jql': query, startAt: received })
                    .accept('application/json')
            } catch (ex: any) {
                this.handleResponseException(ex, `Error finding fallback task of project id: ${projectId}`, `${this._searchUri}?${query}`)
                return null
            }
            total = response.body.total
            response.body.issues.forEach((i: any) => {
                received++
                issues.push(i)
            })
        }
        //query dos not look for equality, but if it contains
        //now check for equality in summary, if more of them are named the same, return the first one
        let issue = issues.find((i: any) => {
            return i.fields.summary === this._fallbackIssueName
        })
        if (!issue) {
            //issue was not created yet
            const issueId = await this._createJiraIssue(projectId, this._fallbackIssueName)
            return issueId
        }
        return issue.id
    }

    private _generateSummarySearchQuery(projectId: number | string, fallbackIssueName: string) {
        return `project=${projectId} AND summary~"${fallbackIssueName}"`
    }

    private async _createJiraIssue(projectId: number | string, summary: string): Promise<number | string | null> {
        const data = {
            "fields": {
                "project": {
                    "id": projectId
                },
                "issuetype": {
                    "name": "Task"
                },
                "summary": summary
            }
        }
        let response
        try {
            response = await superagent
                .post(`${this._issueUri}`)
                .set('Authorization', `Basic ${this._secret}`)
                .accept('application/json')
                .send(data)
        } catch (ex: any) {
            this.handleResponseException(ex, `creating new Issue in Jira`, `${this._projectUri} `)
            return null
        }
        return response.body.id
    }


    handleResponseException(ex: any, functionInfo: string, uri: string): void {
        const status = ex.status
        if (ex != undefined && (status === 403 || status === 401)) {
            const error = this._errorService.createJiraError(ex)
            const context = [
                this._sentryService.createExtraContext("Exception", ex),
                this._sentryService.createExtraContext('Status_code', status)
            ]

            error.data = 'User credentials Error, please check tour credentials'
            const message = `${functionInfo} failed with status code ${status}\nCheck credentials or set user inactive`
            this._sentryService.logJiraError(uri, message, context)
            this.errors.push(error)
        } else {
            const message = `${functionInfo} failed with status code ${status}`
            this._sentryService.logJiraError(uri, message)
        }
    }


}