import { ObjectId } from "mongodb"
import { Connection } from "../models/connection/connection"
import { ServiceObject } from "../models/synced_service/service_object/service_object"
import { JiraTimeEntry } from "../models/synced_service/time_entry/jira_time_entry"
import { TimeEntry } from "../models/synced_service/time_entry/time_entry"
import { databaseService } from "../shared/database_service"
import { SyncedServiceCreator } from "../synced_services/synced_service_creator"
import { Mapping } from "../models/connection/mapping/mapping"
import { MappingsObject } from "../models/connection/mapping/mappings_object"
import { SyncedServiceDefinition } from "../models/connection/config/synced_service_definition"

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
        const connection = await databaseService.getConnectionById(connectionId)//Move to calling service to avoid multiple DB calls 
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
                        await this._createServiceObject(connection, service, newObject as ServiceObject)
                        break
                    case "project":
                        await this._createServiceObject(connection, service, newObject as ServiceObject)
                        break
                    case "worklog":
                        await this._createTimeEntry(connection, service, lastUpdated, newObject as TimeEntry)
                        break
                }
                break
            case "UPDATED":
                switch (eventObject) {
                    case "issue":
                        await this._updateServiceObject(connection, service, newObject as ServiceObject)
                        break
                    case "project":
                        await this._updateServiceObject(connection, service, newObject as ServiceObject)
                        break
                    case "worklog":
                        await this._updateTimeEntry(connection, service, lastUpdated, newObject as TimeEntry)
                        break
                }
                break
        }
        return true
    }

    //issues and projects
    async _createServiceObject(connection: Connection, service: string, newObj: ServiceObject) {
        const notCallingService = connection.firstService.name === service ? connection.secondService : connection.firstService
        const secondServiceObject = await this._createServiceObjectInSeconadyService(connection, service, newObj, notCallingService)
        if (!secondServiceObject) {
            return
        }
        const secondServiceType = newObj.type === 'issue' ? (notCallingService.name === 'Toggl Track' ? 'tag' : 'issue') : 'project'
        //create mapping in connection
        const mapping = new Mapping()
        mapping.primaryObjectId = newObj.id
        mapping.primaryObjectType = newObj.type
        mapping.name = newObj.name
        const primaryMappingObject = new MappingsObject(newObj.id, newObj.name, service, newObj.type)
        const secondaryMappingObject = new MappingsObject(secondServiceObject.id, secondServiceObject.name, notCallingService.name, secondServiceType)
        mapping.mappingsObjects.push(primaryMappingObject)
        mapping.mappingsObjects.push(secondaryMappingObject)
        //save mapping to DB
        //console.log(mapping)
        connection.mappings.push(mapping)
        await databaseService.updateConnectionMappings(connection)
    }
    async _updateServiceObject(connection: Connection, service: string, updatedObj: ServiceObject) {
        console.log('about to update issue')
        const mapping = connection.mappings.find((m: Mapping) => {
            //primary service called
            return m.primaryObjectId === updatedObj.id
        })
        if (!mapping) {
            //mapping was not found, so ignore thw webhook
            return
        }
        if (mapping.name === updatedObj.name) {
            //something else then name changed, I don't care about id
            console.log('names are the same, so no update')
            return
        }
        const primaryServiceNumber = mapping.mappingsObjects[0].service === service ? 0 : 1
        const secondaryServiceNumber = mapping.mappingsObjects[0].service === service ? 1 : 0

        const notCallingService = connection.firstService.name === service ? connection.secondService : connection.firstService
        const secondServiceObject = await this._updateServiceObjectInSeconadyService(connection, mapping.mappingsObjects[secondaryServiceNumber].id, updatedObj, notCallingService)
        if (!secondServiceObject)
            return
        mapping.name = updatedObj.name
        mapping.mappingsObjects[primaryServiceNumber].name = updatedObj.name
        mapping.mappingsObjects[secondaryServiceNumber].name = secondServiceObject.name
        await databaseService.updateConnectionMappings(connection)
    }

    //TimeEntries
    async _createTimeEntry(connection: Connection, service: string, lastUpdated: number | string, newTE: TimeEntry) { }
    async _updateTimeEntry(connection: Connection, service: string, lastUpdated: number | string, newTE: TimeEntry) { }
    async _deleteTimeEntry(connectionId: string, service: string, lastUpdated: number | string, newTE: TimeEntry) { }



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

    private async _createServiceObjectInSeconadyService(connection: Connection, service: string, newObj: ServiceObject, notCallingService: SyncedServiceDefinition): Promise<ServiceObject | null> {
        if (!this._isTicket2Ticket(connection)) {
            //create tag in second service
            const syncedService = SyncedServiceCreator.create(notCallingService)
            try {
                return await syncedService.createServiceObject(newObj.id, newObj.name, newObj.type)
            } catch (err) {
                return null
            }
        } else {
            return null
        }

    }

    private async _updateServiceObjectInSeconadyService(connection: Connection, secondServiceObjectId: number | string, newObj: ServiceObject, notCallingService: SyncedServiceDefinition): Promise<ServiceObject | null> {
        if (!this._isTicket2Ticket(connection)) {
            //create tag in second service
            const syncedService = SyncedServiceCreator.create(notCallingService)
            try {
                return await syncedService.updateServiceObject(secondServiceObjectId, newObj)
            } catch (err) {
                return null
            }
        } else {
            return null
        }

    }
}