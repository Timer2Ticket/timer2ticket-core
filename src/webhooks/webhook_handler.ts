import { ObjectId } from "mongodb"
import { Connection } from "../models/connection/connection"
import { ServiceObject } from "../models/synced_service/service_object/service_object"
import { JiraTimeEntry } from "../models/synced_service/time_entry/jira_time_entry"
import { TimeEntry } from "../models/synced_service/time_entry/time_entry"
import { databaseService } from "../shared/database_service"
import { SyncedServiceCreator } from "../synced_services/synced_service_creator"
import { Mapping } from "../models/connection/mapping/mapping"
import { MappingsObject } from "../models/connection/mapping/mappings_object"

export class WebhookHandler {

    async handleWebhook(data: any) {
        console.log('about to handle webhook')
        const event: string = data.event
        const eventObject: string = data.eventObject

        let connectionId: ObjectId

        try {
            connectionId = new ObjectId(data.connection)
        } catch (err) {
            return
        }
        const connection = await databaseService.getConnectionById(connectionId)
        if (!connection)
            return
        const service: string = data.service
        const lastUpdated: number | string = data.timestamp
        if (event === "DELETED") {
            //deletes are ignored for now
            return
        }
        const newObject = this._getObjectFromWebhook(service, eventObject, lastUpdated, data.newObject)
        if (!newObject)
            return false
        switch (event) {
            case "CREATED":
                switch (eventObject) {
                    case "issue":
                        await this._createIssue(connection, service, lastUpdated, newObject as ServiceObject)
                        break
                    case "project":
                        await this._createProject(connection, service, lastUpdated, newObject as ServiceObject)
                        break
                    case "worklog":
                        await this._createTimeEntry(connection, service, lastUpdated, newObject as TimeEntry)
                        break
                }
                break
            case "UPDATED":
                switch (eventObject) {
                    case "issue":
                        await this._updateIssue(connection, service, lastUpdated, newObject as ServiceObject)
                        break
                    case "project":
                        await this._updateProject(connection, service, lastUpdated, newObject as ServiceObject)
                        break
                    case "worklog":
                        await this._updateTimeEntry(connection, service, lastUpdated, newObject as TimeEntry)
                        break
                }
                break
        }
        return true
    }

    //issues
    async _createIssue(connection: Connection, service: string, lastUpdated: number | string, newIssue: ServiceObject) {
        console.log('about to create Issue')
        const notCallingService = connection.firstService.name === service ? connection.secondService : connection.firstService
        let secondServiceObject
        if (!this._isTicket2Ticket(connection)) {
            //create tag in second service
            const syncedService = SyncedServiceCreator.create(notCallingService)
            try {
                secondServiceObject = await syncedService.createServiceObject(newIssue.id, newIssue.name, newIssue.type)
            } catch (err) {
                return
            }
        } else {
            secondServiceObject = null
        }
        if (!secondServiceObject) {
            return
        }
        const secondServiceType = notCallingService.name === 'Toggl Track' ? 'tag' : 'issue'
        //create mapping in connection
        const mapping = new Mapping()
        mapping.primaryObjectId = newIssue.id
        mapping.primaryObjectType = newIssue.type
        mapping.name = newIssue.name
        const primaryMappingObject = new MappingsObject(newIssue.id, newIssue.name, service, newIssue.type)
        const secondaryMappingObject = new MappingsObject(secondServiceObject.id, secondServiceObject.name, notCallingService.name, secondServiceType)
        mapping.mappingsObjects.push(primaryMappingObject)
        mapping.mappingsObjects.push(secondaryMappingObject)
        //save mapping to DB
        //console.log(mapping)
        connection.mappings.push(mapping)
        await databaseService.updateConnectionMappings(connection)
    }
    async _updateIssue(connection: Connection, service: string, lastUpdated: number | string, newIssue: ServiceObject) { }
    //async _deleteIssue(connectionId: string, service: string, lastUpdated: number | string, newIssue: ServiceObject) { }
    //projects
    async _createProject(connection: Connection, service: string, lastUpdated: number | string, newIssue: ServiceObject) { }
    async _updateProject(connection: Connection, service: string, lastUpdated: number | string, newIssue: ServiceObject) { }
    //async _deleteProject(connectionId: string, service: string, lastUpdated: number | string, newIssue: ServiceObject) { }
    //TimeEntries
    async _createTimeEntry(connection: Connection, service: string, lastUpdated: number | string, newTE: TimeEntry) { }
    async _updateTimeEntry(connection: Connection, service: string, lastUpdated: number | string, newTE: TimeEntry) { }
    //async _deleteTimeEntry(connectionId: string, service: string, lastUpdated: number | string, newTE: TimeEntry) { }



    private _getObjectFromWebhook(service: string, objType: string, lastUpdated: number | string, obj: any) {
        if (service === 'Jira') {
            if (objType === 'worklog') {
                //TODO this will fail on project Id
                return new JiraTimeEntry(obj.id, obj.projectId, obj.text, new Date(obj.start), new Date(obj.end), obj.durationInMilliseconds, new Date(lastUpdated))
            }
            if (objType === 'issue' || objType === 'project') {
                return new ServiceObject(obj.id, obj.name, obj.type)
            }
        }
        return null
    }

    private _isTicket2Ticket(connection: Connection): boolean {
        if ((connection.firstService.name === 'Jira' || connection.firstService.name === 'Redmine') &&
            (connection.secondService.name === 'Jira' || connection.secondService.name === 'Redmine'))
            return true
        else return false
    }
}