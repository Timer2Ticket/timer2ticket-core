import { SyncedServiceDefinition } from "../../models/connection/config/synced_service_definition";
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

        this._issueUri = `${this._domain}api/3/issue`
        this._projectUri = `${this._domain}api/3/project`
        this._searchUri = `${this._domain}/api/3/search`
        this._projectsType = 'project'
        this._issuesType = 'issue'
        this._maxResultsPerSearch = 50

        this.errors = []
        this._sentryService = new SentryService()
        this._errorService = new ErrorService()
    }

    /**
   * Get all service objects which: projects, issues, activities etc.
   * returns false in case of any error
   */
    async getAllServiceObjects(): Promise<ServiceObject[] | boolean> {
        const allServiceObjects: ServiceObject[] = []
        const projects = await this._getAllProjects()
        allServiceObjects.push(...projects)

        const issues = await this._getIssues(projects)
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
                .accept('application/json')
                .type('application/json')
        } catch (ex: any) {
            //TODO
            return []
        }
        const projects: ServiceObject[] = []
        response.body?.forEach((project: any) => {
            projects.push(
                new ServiceObject(project.id, project.name, project._projectsType)
            )
        })
        console.log('Projects are:')
        console.log(projects)
        return projects
    }

    private async _getIssues(projects: ServiceObject[]): Promise<ServiceObject[]> {
        const issues: ServiceObject[] = []
        for (const project of projects) {
            const issuesOfProject = await this._getIssuesOfProject(project.id)
            issues.push(...issuesOfProject)
        }
        return []
    }
    private async _getIssuesOfProject(projectIdOrKey: string | number, start?: Date, end?: Date): Promise<ServiceObject[]> {
        const issues: ServiceObject[] = []

        let total = 1
        let received = 0
        while (total > received) {
            const query = this._generateTimeEntriesQuery(projectIdOrKey, received, start, end)
            let response
            try {
                response = await superagent
                    .get(`${this._searchUri}?${query}`)
                    .set('Authorization', `Basic ${this._secret}`)
                    .accept('application/json')
            } catch (ex: any) {
                return []
                //TODO better
            }
            total = response.body.total
            const responseIssues = response.body.issues
            responseIssues.forEach((issue: any) => {
                received++
                issues.push(new ServiceObject(issue.id, issue.fields.summary, this._issuesType))
            })
        }
        return issues
    }

    private _generateTimeEntriesQuery(projectIdOrKey: string | number, startAtPageNumber: number, start?: Date, end?: Date): string {
        let query = `jql=project=${projectIdOrKey}&startAt=${startAtPageNumber}`
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
                throw new Error('Creating issues in Jira is not supported yet')
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
     */
    async getTimeEntries(start?: Date, end?: Date): Promise<TimeEntry[]> {
        const timeEntries: JiraTimeEntry[] = []

        const projects = await this._getAllProjects()
        for (const project of projects) {
            const issues = await this._getIssuesOfProject(project.id, start, end)
            for (const issue of issues) {
                try {
                    const response = await superagent
                        .get(`${this._issueUri}/${issue.id}/worklog`)
                        .set('Authorization', `Basic ${this._secret}`)
                        .accept('application/json')
                    if (response.body.fields.worklog) {
                        const worklogs = response.body.worklogs
                        worklogs.forEach((worklog: any) => {
                            const durationInMilliseconds = worklog.timeSpentInSeconds * 1000
                            const teStart = new Date(worklog.started)

                            timeEntries.push(new JiraTimeEntry(
                                this._createTimeEntryId(issue.id, worklog.id),
                                project.id,
                                worklog.comment.content[0].content[0].text,
                                teStart,
                                this._calculateEndfromStartAndDuration(teStart, durationInMilliseconds),
                                durationInMilliseconds,
                                new Date(worklog.updated),
                            ))
                        })
                    }
                } catch (ex: any) {
                    //TODO
                    return timeEntries
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
            return null
        }
        if (!response || !response.ok || response.body.fields.worklog.total === 0) {
            return null
        }

        const worklogs = response.body.fields.worklog.worklogs
        const myWorklog = worklogs.find((w: any) => w.id === worklogId)
        if (!myWorklog)
            return null
        const durationInMilliseconds = myWorklog.timeSpentInSeconds * 1000
        const teStart = new Date(myWorklog.started)

        return new JiraTimeEntry(
            id,
            response.body.fields.project.id,
            myWorklog.comment[0].content[0].text,
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
        let issueId //issue Id would be enough if project id was not aprt of Time Entry object

        for (const data of additionalData) {
            if (data.type === this._projectsType) {
                projectId = data.id
            } else if (data.type === this._issuesType) {
                issueId = data.id
            }
        }

        if (!issueId || !projectId) {
            //both are required (project maybe not, depends on the design TODO)
            return null
        }

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
            "started": start,
            "timeSpentSeconds": durationInMilliseconds * 1000
        }
        let response
        try {
            response = await superagent
                .post(`${this._issueUri}/${issueId}/worklog`)
                .set('Authorization', `Basic ${this._secret}`)
                .accept('application/json')
                .send(data)
        } catch (ex: any) {
            return null
        }

        const teStart = new Date(response.body.started)

        const newTimeEntry = new JiraTimeEntry(
            this._createTimeEntryId(issueId, response.body.id),
            projectId,
            response.body.comment.content[0].content[0].text,
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
        } catch {
            return false
        }
        if (response.status !== 204)
            return false

        return true
    }

    /**
     * Extracts objects from specific timeEntry other than Jira
     * @param timeEntry timeEntry object from which mappingsObjects are extracting - each specific manager has its specific time entry instance (e.g. TogglTimeEntry)
     * @param mappings user's mappings where to find mappingsObjects (by id)
     */
    extractMappingsObjectsFromTimeEntry(timeEntry: TimeEntry, mappings: Mapping[]): MappingsObject[] {
        if (!(timeEntry instanceof JiraTimeEntry))
            return []
        const results: MappingsObject[] = []
        for (const mapping of mappings) {
            const obj = mapping.mappingsObjects.find(o => o.service === this._serviceName)
            if (obj) {
                if ((obj.id === timeEntry.projectId && obj.type === this._projectsType)
                    || (obj.id === this._issueIdFromTimeEntryId(timeEntry.id) && obj.type === this._issuesType)
                ) {
                    const notJiraMappings = mapping.mappingsObjects.filter(o => o.name !== this._serviceName)
                    //push other than Jira
                    results.push(...notJiraMappings)
                }
            }
        }
        return results
    }

    async getTimeEntriesRelatedToMappingObjectForConnection(mapping: Mapping, connection: Connection): Promise<TimeEntry[] | null> {
        if (mapping.primaryObjectType !== this._issuesType) {
            return null
        }
        const jiraServiceDefinition = Connection.findServiceDefinitionByName(this._serviceName, connection)
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
            //todo maybe something more
            return null
        }
        if (!response || !response.ok)
            return null

        const issue = response.body
        for (const worklog of issue.fields.worklog.worklogs) {
            const start = new Date(worklog.started)
            const durationInMiliseconds = worklog.timeSpentSeconds
            const timeEntry = new JiraTimeEntry(
                this._createTimeEntryId(issueId, worklog.id),
                issue.fields.project.id,
                worklog.comment.content[0].content[0].text,
                start,
                this._calculateEndfromStartAndDuration(start, durationInMiliseconds),
                durationInMiliseconds,
                new Date(worklog.updated)
            )
            timeEntries.push(timeEntry)
        }
        return timeEntries
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
}