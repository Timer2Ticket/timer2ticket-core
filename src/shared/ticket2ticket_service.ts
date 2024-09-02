import { SyncedServiceDefinition } from "../models/connection/config/synced_service_definition";
import { Connection } from "../models/connection/connection";
import { jiraSyncedService } from "../synced_services/jira/jira_synced_service";


export function isTicket2TicketConnection(connection: Connection): boolean {
    const ticketTools = ['Jira', 'Redmine']
    return ticketTools.includes(connection.firstService.name) && ticketTools.includes(connection.secondService.name)
}


export async function getIdOfAnotherServiceIdFromLink(service: SyncedServiceDefinition, customFieldValue: string | number | null): Promise<string | number | null> {
    if (customFieldValue && service.name === 'Jira') {
        //issue key is used in jira link, need to extract it and get key via API request
        const splitedValue = customFieldValue.toString().split('/')
        const issueKey = splitedValue[splitedValue.length - 1]
        const syncedService = new jiraSyncedService(service)
        let issueId
        try {
            issueId = await syncedService.getIssueIdFromIssueKey(issueKey)
        } catch (ex) {
            return null
        }
        if (issueId)
            return issueId
        else
            return null
    } else if (customFieldValue && service.name === 'Redmine') {
        const splitedValue = customFieldValue.toString().split('/')
        const idPlusQuery = splitedValue[splitedValue.length - 1]
        const issueId = idPlusQuery.split('?')[0]
        return issueId
    } else {
        return null
    }
}