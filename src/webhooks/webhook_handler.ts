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
import { TimeEntrySyncedObject } from "../models/synced_service/time_entry_synced_object/time_entry_synced_object"
import { ServiceTimeEntryObject } from "../models/synced_service/time_entry_synced_object/service_time_entry_object"
import { WebhookEventData } from "../models/connection/config/webhook_event_data"
import { jiraSyncedService } from "../synced_services/jira/jira_synced_service"
import { SyncedService } from "../synced_services/synced_service"

export class WebhookHandler {
    data: WebhookEventData
    connection: Connection
    serviceObject?: ServiceObject
    timeEntry?: TimeEntry

    constructor(data: WebhookEventData, connection: Connection) {
        this.data = data
        this.connection = connection
    }



    async handleWebhook(): Promise<boolean> {
        console.log('about to handle webhook')

        //TODO do for more then just Jira
        const syncedService = SyncedServiceCreator.create(this.data.serviceNumber === 1 ? this.connection.firstService : this.connection.secondService) as jiraSyncedService
        const dataFromService = this._getDataFromRemote(syncedService)
        if (!dataFromService) {
            return false
        }
        if (!this.serviceObject || (this.data.type === 'worklog' && !this.timeEntry))
            return false
        switch (this.data.event) {
            case "CREATED":
                switch (this.data.type) {
                    case "issue":
                        await this._createServiceObject()
                        break
                    case "project":
                        await this._createServiceObject()
                        break
                    case "worklog":
                        await this._createTimeEntry()
                        break
                }
                break
            case "UPDATED":
                switch (this.data.type) {
                    case "issue":
                        await this._updateServiceObject()
                        break
                    case "project":
                        await this._updateServiceObject()
                        break
                    // case "worklog":
                    //     await this._updateTimeEntry(connection, service, lastUpdated, newTE!, newObject)
                    //     break
                }
                break
            case "DELETED":
                switch (this.data.type) {
                    case "woklog":
                        await this._deleteTimeEntry()
                }
        }
        return true
    }

    //issues and projects
    async _createServiceObject() {
        const newObj = this.serviceObject!
        const notCallingService = this.data.serviceNumber === 1 ? this.connection.secondService : this.connection.firstService
        const secondServiceObject = await this._createServiceObjectInSeconadyService(this.connection, newObj, notCallingService)
        if (!secondServiceObject) {
            return
        }
        const secondServiceType = this.data.type === 'issue' ? (notCallingService.name === 'Toggl Track' ? 'tag' : 'issue') : 'project'
        //create mapping in connection
        const mapping = new Mapping()
        mapping.primaryObjectId = newObj.id
        mapping.primaryObjectType = newObj.type
        mapping.name = newObj.name
        const serviceName = this.data.serviceNumber === 2 ? this.connection.secondService.name : this.connection.firstService.name
        const primaryMappingObject = new MappingsObject(newObj.id, newObj.name, serviceName, newObj.type)
        const secondaryMappingObject = new MappingsObject(secondServiceObject.id, secondServiceObject.name, notCallingService.name, secondServiceType)
        mapping.mappingsObjects.push(primaryMappingObject)
        mapping.mappingsObjects.push(secondaryMappingObject)
        //save mapping to DB
        //console.log(mapping)
        this.connection.mappings.push(mapping)
        //await databaseService.updateConnectionMappings(this.connection)
    }
    async _updateServiceObject() {
        console.log('about to update issue')
        const updatedObj = this.serviceObject!
        const mapping = this.connection.mappings.find((m: Mapping) => {
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
        const primaryServiceMappingObject = mapping.mappingsObjects[0].id === this.data.id ? mapping.mappingsObjects[0] : mapping.mappingsObjects[1]
        const secondaryServiceMappingObject = mapping.mappingsObjects[0].id === this.data.id ? mapping.mappingsObjects[1] : mapping.mappingsObjects[0]

        const notCallingService = this.data.serviceNumber === 2 ? this.connection.secondService : this.connection.firstService
        const secondServiceObject = await this._updateServiceObjectInSeconadyService(this.connection, secondaryServiceMappingObject.id, updatedObj, notCallingService)
        if (!secondServiceObject)
            return
        mapping.name = updatedObj.name
        primaryServiceMappingObject.name = updatedObj.name
        secondaryServiceMappingObject.name = secondServiceObject.name
        //await databaseService.updateConnectionMappings(this.connection)
    }

    //TimeEntries
    async _createTimeEntry() {
        console.log('about to create TE')
        const newTE = this.timeEntry!
        const serviceObject = this.serviceObject!
        const serviceName = this.data.serviceNumber === 1 ? this.connection.firstService.name : this.connection.secondService.name
        const notCallingService = this.data.serviceNumber === 1 ? this.connection.secondService : this.connection.firstService
        const secondServiceObject = await this._createTEInSecondService(this.connection, newTE, notCallingService, serviceObject)
        if (!secondServiceObject) {
            return
        }
        //  const secondServiceObject = new ServiceObject(1, 'ahoj', 'tag', 10)
        const STEOorigin = new ServiceTimeEntryObject(serviceObject.id, serviceName, true)
        const STEOsecond = new ServiceTimeEntryObject(secondServiceObject.id, notCallingService.name, false)
        const TESO = new TimeEntrySyncedObject(this.connection._id, newTE.start)
        TESO.serviceTimeEntryObjects.push(STEOorigin)
        TESO.serviceTimeEntryObjects.push(STEOsecond)

        //await databaseService.createTimeEntrySyncedObject(TESO);
    }
    //async _updateTimeEntry() { }
    async _deleteTimeEntry() {
        console.log('about to delete Time Entry')
        //find TESO by ID of calling TE ID
        const TESOsOfConnection = await databaseService.getTimeEntrySyncedObjects(this.connection)
        if (!TESOsOfConnection)
            return
        const TESO2Delete = TESOsOfConnection.find((te: TimeEntrySyncedObject) => {
            return te.serviceTimeEntryObjects[0].id === this.data.id || te.serviceTimeEntryObjects[1].id === this.data.id
        })
        if (!TESO2Delete)
            return
        //delete TE in second service
        //TODO

        //delete TESO
        //await databaseService.deleteTimeEntrySyncedObject(TESO2Delete)
    }



    private async _getDataFromRemote(syncedService: SyncedService): Promise<boolean> {
        const service = this.data.serviceNumber === 1 ? this.connection.firstService.name : this.connection.secondService.name
        if (service === 'Jira') {
            const jiraSyncedService = syncedService as jiraSyncedService
            const serviceObjectTupple = await jiraSyncedService.getObjectsFromWebhook(this.data)
            if (!serviceObjectTupple || !serviceObjectTupple[1])
                return false
            this.serviceObject = serviceObjectTupple[0]
            this.timeEntry = serviceObjectTupple[1]
        }
        return true
    }

    private _isTicket2Ticket(connection: Connection): boolean {
        if ((connection.firstService.name === 'Jira' || connection.firstService.name === 'Redmine') &&
            (connection.secondService.name === 'Jira' || connection.secondService.name === 'Redmine'))
            return true
        else return false
    }

    private async _createServiceObjectInSeconadyService(connection: Connection, newObj: ServiceObject, notCallingService: SyncedServiceDefinition): Promise<ServiceObject | null> {
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

    private async _createTEInSecondService(connection: Connection, newTE: TimeEntry, notCallingService: SyncedServiceDefinition, serviceObject: ServiceObject): Promise<TimeEntry | null> {
        console.log('abaut to crate TE in second service')
        if (!this._isTicket2Ticket(connection)) {
            const syncedService = SyncedServiceCreator.create(notCallingService)
            const start = new Date(newTE.start)
            const end = new Date(newTE.end)
            const additionalData: ServiceObject[] = []
            connection.mappings.forEach((mapping: Mapping) => {
                let secondaryMappingObject = null
                if (mapping.primaryObjectId === serviceObject.id) { //issues
                    secondaryMappingObject = mapping.mappingsObjects[0].id === serviceObject.id
                        ? mapping.mappingsObjects[1]
                        : mapping.mappingsObjects[0]
                } else if (mapping.primaryObjectId === serviceObject.projectId) { //projects
                    secondaryMappingObject = mapping.mappingsObjects[0].id === serviceObject.projectId
                        ? mapping.mappingsObjects[1]
                        : mapping.mappingsObjects[0]
                }
                if (secondaryMappingObject) {
                    additionalData.push(
                        new ServiceObject(secondaryMappingObject.id,
                            secondaryMappingObject.name,
                            secondaryMappingObject.type)
                    )
                }
            })
            if (!start || !end)
                return null
            try {
                return await syncedService.createTimeEntry(newTE.durationInMilliseconds, start, end, newTE.text, additionalData)
            } catch (err) {
                return null
            }
        } else {
            return null
        }
    }
}