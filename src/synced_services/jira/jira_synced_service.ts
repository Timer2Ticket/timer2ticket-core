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

    private _issueUri: string
    private _projectUri: string
    private _projectsType: string
    private _issuesType: string


    errors: Array<Timer2TicketError>;
    readonly _sentryService: SentryService
    readonly _errorService: ErrorService

    constructor(syncedServiceDefinition: SyncedServiceDefinition) {
        this._domain = syncedServiceDefinition.config.domain!
        this._apiKey = syncedServiceDefinition.config.apiKey
        this._userEmail = syncedServiceDefinition.config.userEmail!

        this._issueUri = `${this._domain}api/3/issue`
        this._projectUri = `${this._domain}api/3/project`
        this._projectsType = 'project'
        this._issuesType = 'issue'

        this.errors = []
        this._sentryService = new SentryService()
        this._errorService = new ErrorService()
    }

    /**
   * Get all service objects which: projects, issues, activities etc.
   * returns false in case of any error
   */
    async getAllServiceObjects(): Promise<ServiceObject[] | boolean> {
        const projects = await this._getAllProjects()
        if (projects.length === 0) {
            return false
        }
        const issues = await this._getIssues(projects)



        return new Promise((resolve, reject) => {
            reject(false)
        })
    }

    private async _getAllProjects(): Promise<ServiceObject[]> {
        const secret = Buffer.from(`${this._userEmail}:${this._apiKey}`).toString("base64")
        let response
        try {
            response = await superagent
                .get(this._projectUri)
                .set('Authorization', `Basic ${secret}`)
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
        //TODO get all issues per project - not easy think about it more
        return []
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
            //return await this._createIssueObject(objectId, objectName, objectType, projectId)
            // case this._projectsType:
            //     throw new Error('Creating projects in Jira is not allowed')
            default:
                throw new Error(`Unsupported type of ${objectType} in Jira`)
        }
    }

    private async _createIssueObject(objectId: string | number, objectName: string, objectType: string, projectId: string | number): Promise<ServiceObject> {
        return new Promise((resolve, reject) => {
            reject(new ServiceObject(objectId, objectName, objectType))
        })
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
        return ''
    }

    /**
     * getTimeEntries
     */
    getTimeEntries(start?: Date, end?: Date): Promise<TimeEntry[]> {
        return new Promise((resolve, reject) => {
            reject([])
        })
    }

    /**
     * Returns only one time entry based on given id
     */
    getTimeEntryById(id: number | string, start?: Date): Promise<TimeEntry | null> {
        return new Promise((resolve, reject) => {
            reject(null)
        })
    }

    /**
     * Create a new time entry real object in the service, returns specific TimeEntry
     * @param durationInMilliseconds 
     * @param start 
     * @param end 
     * @param text 
     * @param additionalData 
     */
    createTimeEntry(durationInMilliseconds: number, start: Date, end: Date, text: string, additionalData: ServiceObject[]): Promise<TimeEntry | null> {
        return new Promise((resolve, reject) => {
            reject(null)
        })
    }

    /**
     * Delete time entry with given id, returns true if successfully deleted
     * @param id of the time entry to delete from the service
     */
    deleteTimeEntry(id: string | number): Promise<boolean> {
        return new Promise((resolve, reject) => {
            reject(false)
        })
    }

    /**
     * Extracts objects from specific timeEntry, e.g. toggl extracts projectId from projectId, issue and time entry activity from TE's tags
     * @param timeEntry timeEntry object from which mappingsObjects are extracting - each specific manager has its specific time entry instance (e.g. TogglTimeEntry)
     * @param mappings user's mappings where to find mappingsObjects (by id)
     */
    extractMappingsObjectsFromTimeEntry(timeEntry: TimeEntry, mappings: Mapping[]): MappingsObject[] {
        return []
    }

    getTimeEntriesRelatedToMappingObjectForConnection(mapping: Mapping, connection: Connection): Promise<TimeEntry[] | null> {
        return new Promise((resolve, reject) => {
            reject(null)
        })
    }


}