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
import { setContext } from "@sentry/node"
import { getIdOfAnotherServiceIdFromLink, isTicket2TicketConnection } from "../shared/ticket2ticket_service"

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

        if (this.data.event === "DELETED" && this.data.type === "worklog") {
            await this._deleteTimeEntry()
            return true
        }
        const syncedService = SyncedServiceCreator.create(this.data.serviceNumber === 1 ? this.connection.firstService : this.connection.secondService)
        const dataFromService = await this._getDataFromRemote(syncedService)
        if (!dataFromService) {
            console.log('data ze service chybi')
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
                    case "worklog":
                        await this._updateTimeEntry()
                        break
                }
                break
        }
        return true
    }

    //issues and projects
    private async _createServiceObject() {
        const newObj = this.serviceObject!
        let secondServiceObject
        const notCallingService = this.data.serviceNumber === 1 ? this.connection.secondService : this.connection.firstService
        if (this._isTicket2Ticket(this.connection) && newObj.syncCustomFieldValue) {
            secondServiceObject = await this._getIssueForTicket2TicketMapping(this.connection, notCallingService, newObj)
        } else {
            secondServiceObject = await this._createServiceObjectInSeconadyService(this.connection, newObj, notCallingService)
        }
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
        await databaseService.updateConnectionMappings(this.connection)
    }
    private async _updateServiceObject() {
        console.log('about to update issue')
        const updatedObj = this.serviceObject!
        const mapping = this.connection.mappings.find((m: Mapping) => {
            //primary service called
            return m.primaryObjectId === updatedObj.id
        })
        if (!mapping) {
            //mapping was not found, ignore for Timer2Ticket Connection, but try to create one for Ticket2Ticket
            if (!isTicket2TicketConnection(this.connection))
                return
            else {
                await this._createServiceObject()
                return
            }
        }
        if (mapping.name === updatedObj.name || isTicket2TicketConnection(this.connection)) {
            console.log('nothing to be updated on this issue')
            return
        }
        const primaryServiceMappingObject = mapping.mappingsObjects[0].id == this.data.id ? mapping.mappingsObjects[0] : mapping.mappingsObjects[1]
        const secondaryServiceMappingObject = mapping.mappingsObjects[0].id == this.data.id ? mapping.mappingsObjects[1] : mapping.mappingsObjects[0]

        const notCallingService = this.data.serviceNumber === 1 ? this.connection.secondService : this.connection.firstService
        const secondServiceObject = await this._updateServiceObjectInSeconadyService(this.connection, secondaryServiceMappingObject.id, updatedObj, notCallingService)
        if (!secondServiceObject)
            return
        mapping.name = updatedObj.name
        primaryServiceMappingObject.name = updatedObj.name
        secondaryServiceMappingObject.name = secondServiceObject.name
        await databaseService.updateConnectionMappings(this.connection)
    }

    //TimeEntries
    private async _createTimeEntry() {
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
        const STEOorigin = new ServiceTimeEntryObject(this.data.id, serviceName, true)
        const STEOsecond = new ServiceTimeEntryObject(secondServiceObject.id, notCallingService.name, false)
        const TESO = new TimeEntrySyncedObject(this.connection._id, newTE.start)
        TESO.serviceTimeEntryObjects.push(STEOorigin)
        TESO.serviceTimeEntryObjects.push(STEOsecond)

        await databaseService.createTimeEntrySyncedObject(TESO);
        console.log('TE Created')
    }
    private async _updateTimeEntry() {
        console.log('about to update TE')
        const TESOsOfConnection = await databaseService.getTimeEntrySyncedObjects(this.connection)
        if (!TESOsOfConnection)
            return
        const TESO2Update = TESOsOfConnection.find((te: TimeEntrySyncedObject) => {
            return te.serviceTimeEntryObjects[0].id === this.data.id || te.serviceTimeEntryObjects[1].id === this.data.id
        })
        if (!TESO2Update) {
            console.log('time entry to update not found')
            await this._createTimeEntry()
            return
        } else {
            const callingServiceName = this.data.serviceNumber === 1 ? this.connection.firstService.name : this.connection.secondService.name
            const updatedTE = this.timeEntry!
            const serviceObject = this.serviceObject!
            const notCallingService = this.data.serviceNumber === 1 ? this.connection.secondService : this.connection.firstService
            if ((!TESO2Update.serviceTimeEntryObjects[0].isOrigin && TESO2Update.serviceTimeEntryObjects[0].service === callingServiceName) ||
                (!TESO2Update.serviceTimeEntryObjects[1].isOrigin && TESO2Update.serviceTimeEntryObjects[1].service === callingServiceName)) {
                return
            }
            const secondServiceObject = await this._updateTEInSecondService(this.connection, updatedTE, notCallingService, serviceObject, TESO2Update)
            if (!secondServiceObject) {
                return
            }
            const STEOIndex = TESO2Update.serviceTimeEntryObjects[0].id === secondServiceObject.id ? 0 : 1
            const newSTEO = new ServiceTimeEntryObject(secondServiceObject.id, notCallingService.name, false)
            TESO2Update.serviceTimeEntryObjects[STEOIndex] = newSTEO
            TESO2Update.lastUpdated = Date.now()
            await databaseService.updateTimeEntrySyncedObject(TESO2Update)
            console.log('updated')
        }
    }



    private async _deleteTimeEntry() {
        console.log('about to delete Time Entry')
        //find TESO by ID of calling TE ID
        const TESOsOfConnection = await databaseService.getTimeEntrySyncedObjects(this.connection)
        if (!TESOsOfConnection) {
            console.log('no TESOs of connection found')
            return
        }
        const TESO2Delete = TESOsOfConnection.find((te: TimeEntrySyncedObject) => {
            return te.serviceTimeEntryObjects[0].id === this.data.id || te.serviceTimeEntryObjects[1].id === this.data.id
        })
        if (!TESO2Delete) {
            console.log('no teso 2 delete')
            return
        }
        //check if TE was deleted in source service
        const callingServiceName = this.data.serviceNumber === 1 ? this.connection.firstService.name : this.connection.secondService.name
        if ((!TESO2Delete.serviceTimeEntryObjects[0].isOrigin && TESO2Delete.serviceTimeEntryObjects[0].service === callingServiceName) ||
            (!TESO2Delete.serviceTimeEntryObjects[1].isOrigin && TESO2Delete.serviceTimeEntryObjects[1].service === callingServiceName)) {
            console.log('service that is not a source called')
            return
        }
        //delete TE in second service
        const notCallingService = this.data.serviceNumber === 1 ? this.connection.secondService : this.connection.firstService
        const idTodelete = TESO2Delete.serviceTimeEntryObjects[0].isOrigin ? TESO2Delete.serviceTimeEntryObjects[1].id : TESO2Delete.serviceTimeEntryObjects[0].id
        const result = await this._deleteTEInSecondService(idTodelete, notCallingService)
        //delete TESO
        if (result)
            await databaseService.deleteTimeEntrySyncedObject(TESO2Delete)
        console.log('end of deletion')
    }



    private async _getDataFromRemote(syncedService: SyncedService): Promise<boolean> {
        const service = this.data.serviceNumber === 1 ? this.connection.firstService : this.connection.secondService
        const syncCustomField = service.config.customField?.id
        let serviceObjectTupple
        try {
            serviceObjectTupple = await syncedService.getObjectsFromWebhook(this.data, syncCustomField)
        } catch (ex) {
            return false
        }
        if (!serviceObjectTupple)
            return false
        this.serviceObject = serviceObjectTupple[0]
        if (this.data.type === "worklog" && serviceObjectTupple[1])
            this.timeEntry = serviceObjectTupple[1]!
        else if (this.data.type === "worklog" && !serviceObjectTupple[1]) {
            return false
        }
        return true
    }

    private _isTicket2Ticket(connection: Connection): boolean { //TODO remove
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

    private async _getIssueForTicket2TicketMapping(connection: Connection, notCallingService: SyncedServiceDefinition, serviceObject: ServiceObject): Promise<ServiceObject | null> {
        if (this._isTicket2Ticket(connection)) {
            const syncedService = SyncedServiceCreator.create(notCallingService)
            const customField = this.data.serviceNumber ? connection.secondService.config.customField?.id : connection.firstService.config.customField?.id
            if (!customField)
                return null
            let serviceObjects
            try {
                serviceObjects = await syncedService.getAllServiceObjects(customField)
            } catch (err) {
                return null
            }
            if (!serviceObjects || serviceObjects === true)
                return null
            const idFromCustomFieldLink = await getIdOfAnotherServiceIdFromLink(notCallingService, serviceObject.syncCustomFieldValue)
            const foundObject = serviceObjects.find((o: ServiceObject) => {
                return idFromCustomFieldLink == o.id
            })
            return foundObject ? foundObject : null
        }
        else return null
    }

    private async _updateServiceObjectInSeconadyService(connection: Connection, secondServiceObjectId: number | string, newObj: ServiceObject, notCallingService: SyncedServiceDefinition): Promise<ServiceObject | null> {
        if (!this._isTicket2Ticket(connection)) {
            //create tag in second service
            const syncedService = SyncedServiceCreator.create(notCallingService)
            try {
                return await syncedService.updateServiceObject(secondServiceObjectId, newObj)
            } catch (err) {
                // console.log(err)
                return null
            }
        } else {
            return null
        }

    }

    private async _createTEInSecondService(connection: Connection, newTE: TimeEntry, notCallingService: SyncedServiceDefinition, serviceObject: ServiceObject): Promise<TimeEntry | null> {
        console.log('abaut to crate TE in second service')
        const syncedService = SyncedServiceCreator.create(notCallingService)
        const start = new Date(newTE.start)
        const end = new Date(newTE.end)
        const additionalData: ServiceObject[] = []
        connection.mappings.forEach((mapping: Mapping) => {
            let secondaryMappingObject
            if (mapping.primaryObjectType === 'issue' && (
                mapping.mappingsObjects[0].id === serviceObject.id ||
                mapping.mappingsObjects[1].id === serviceObject.id)) { //issues and tags
                secondaryMappingObject = mapping.mappingsObjects[0].id === serviceObject.id
                    ? mapping.mappingsObjects[1]
                    : mapping.mappingsObjects[0]

            } else if (mapping.primaryObjectType === 'project' && (
                mapping.mappingsObjects[0].id === serviceObject.projectId ||
                mapping.mappingsObjects[1].id === serviceObject.projectId)
            ) { //projects
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
        if (!start || !end || additionalData.length < 1) {
            return null
        }
        try {
            const result = await syncedService.createTimeEntry(newTE.durationInMilliseconds, start, end, newTE.text, additionalData)
            return result
        } catch (err) {
            console.log(err)
            return null
        }

    }

    private async _deleteTEInSecondService(TEid: number | string, secondService: SyncedServiceDefinition): Promise<boolean> {
        const syncedService = SyncedServiceCreator.create(secondService)
        console.log('about do delete TE in second sercice')
        let deleted
        try {
            deleted = await syncedService.deleteTimeEntry(TEid)
        } catch (ex) {
            return false
        }
        if (deleted)
            return true
        else
            return false
    }

    private async _updateTEInSecondService(connection: Connection, updatedTE: TimeEntry, notCallingService: SyncedServiceDefinition, serviceObject: ServiceObject, TESO2Update: TimeEntrySyncedObject): Promise<TimeEntry | null> {
        console.log('about to update te in second service')
        //first delete and then create new, because of permisions
        const idInSecondService = TESO2Update.serviceTimeEntryObjects[0].id === this.data.id ? TESO2Update.serviceTimeEntryObjects[1].id : TESO2Update.serviceTimeEntryObjects[0].id
        const deleted = await this._deleteTEInSecondService(idInSecondService, notCallingService)
        const newTE = await this._createTEInSecondService(connection, updatedTE, notCallingService, serviceObject)
        if (!newTE)
            return null
        return newTE
    }
}