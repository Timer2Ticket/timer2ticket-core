import { ObjectID, ObjectId } from "mongodb"

export class WebhookEventData {
    type: string
    id: number | string
    timestamp: Date
    connectionId: ObjectId
    serviceNumber: number
    event: string

    constructor(type: string, id: number | string, event: string, timestamp: Date, connectionId: ObjectId, serviceNumber: number) {
        this.type = type
        this.id = id
        this.timestamp = timestamp
        this.connectionId = connectionId
        this.serviceNumber = serviceNumber
        this.event = event
    }
}