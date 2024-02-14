import { ServiceObject } from "../models/synced_service/service_object/service_object"
import { JiraTimeEntry } from "../models/synced_service/time_entry/jira_time_entry"
import { TimeEntry } from "../models/synced_service/time_entry/time_entry"

export class WebhookHandler {

    async handleWebhook(data: any) {
        const event: string = data.event
        const eventObject: string = data.eventObject
        const connectionId: string = data.connections
        const service: string = data.service
        const lastUpdated: number | string = data.timestamp
        if (event === "DELETED") {
            //delete
        }
        const newObject = this._getObjectFromWebhook(service, eventObject, lastUpdated, data.newObject)
        if (!newObject)
            return false
        switch (event) {
            case "CREATED":
                switch (eventObject) {
                    case "ISSUE":
                        await this._createIssue(connectionId, service, lastUpdated, newObject as ServiceObject)
                        break
                    case "PROJECT":
                        await this._createProject(connectionId, service, lastUpdated, newObject as ServiceObject)
                        break
                    case "WORKLOG":
                        await this._createTimeEntry(connectionId, service, lastUpdated, newObject as TimeEntry)
                        break
                }
                break
            case "UPDATED":
                switch (eventObject) {
                    case "ISSUE":
                        await this._updateIssue(connectionId, service, lastUpdated, newObject as ServiceObject)
                        break
                    case "PROJECT":
                        await this._updateProject(connectionId, service, lastUpdated, newObject as ServiceObject)
                        break
                    case "WORKLOG":
                        await this._updateTimeEntry(connectionId, service, lastUpdated, newObject as TimeEntry)
                        break
                }
                break
        }
        return true
    }

    //issues
    async _createIssue(connectionId: string, service: string, lastUpdated: number | string, newIssue: ServiceObject) { }
    async _updateIssue(connectionId: string, service: string, lastUpdated: number | string, newIssue: ServiceObject) { }
    //async _deleteIssue(connectionId: string, service: string, lastUpdated: number | string, newIssue: ServiceObject) { }
    //projects
    async _createProject(connectionId: string, service: string, lastUpdated: number | string, newIssue: ServiceObject) { }
    async _updateProject(connectionId: string, service: string, lastUpdated: number | string, newIssue: ServiceObject) { }
    //async _deleteProject(connectionId: string, service: string, lastUpdated: number | string, newIssue: ServiceObject) { }
    //TimeEntries
    async _createTimeEntry(connectionId: string, service: string, lastUpdated: number | string, newTE: TimeEntry) { }
    async _updateTimeEntry(connectionId: string, service: string, lastUpdated: number | string, newTE: TimeEntry) { }
    //async _deleteTimeEntry(connectionId: string, service: string, lastUpdated: number | string, newTE: TimeEntry) { }



    private _getObjectFromWebhook(service: string, objType: string, lastUpdated: number | string, obj: any) {
        if (service === 'Jira') {
            if (objType === 'WORKLOG') {
                return new JiraTimeEntry(obj.id, obj.projectId, obj.text, new Date(obj.start), new Date(obj.end), obj.durationInMilliseconds, new Date(lastUpdated))
            }
            if (objType === 'ISSUE' || objType === 'PROJECT') {
                return new ServiceObject(obj.id, obj.name, obj.type, obj.projectId)
            }
        }


    }
}