import { SyncedServiceDefinition } from "./models/connection/config/synced_service_definition";
import { ServiceObject } from "./models/synced_service/service_object/service_object";
import { jiraSyncedService } from "./synced_services/jira/jira_synced_service";
import { SyncedServiceCreator } from "./synced_services/synced_service_creator";

//const serviceDefinition = new SyncedServiceDefinition()


const serviceDefinition: SyncedServiceDefinition = {
    name: 'Jira',
    config: {
        userId: 1,
        apiKey: 'ATATT3xFfGF0FhNogVFllGr2xKjt1YoQ6Qvj4cJYPmTM0wpOxttwaMBaHcENA_Lkj4VaNItWNHLwG4rV1K-Lx6EQWgLqu5WUaPe9m5ONztQuFp4o50YnPcRLYUTnLztJ0CjBNImOoMSGTxpNzNEAIeFEAgL1tOg_uXjRvsL3WqL_FvR3PdGaNHQ=87AD994D',
        domain: 'https://fit-starujan.atlassian.net/',
        userEmail: 'starujan@fit.cvut.cz',
        defaultTimeEntryActivity: null,
        apiPoint: null,
        workspace: null
    }
}


const syncedService = SyncedServiceCreator.create(serviceDefinition);
//getAllServiceObjects()
//getTimeEntries()
//getTimeEntryById('10002_10004')
//createTimeEntry()
deleteTimeEntry('10002_10017')


async function getAllServiceObjects() {
    const objects = await syncedService.getAllServiceObjects()
    console.log(objects)
}
async function getTimeEntries() {
    const objects = await syncedService.getTimeEntries()
    console.log(objects)
}
async function getTimeEntryById(id: string | number) {
    const object = await syncedService.getTimeEntryById(id)
    console.log(object)
}
async function createTimeEntry() {
    const durationInMiliseconds = 10000
    const start = new Date()
    const end = new Date()
    const text: string = 'zaznam vytvoreny T2T'
    const additionalData: ServiceObject[] = []

    const issue: ServiceObject = {
        id: 10002,
        name: 'name of issue',
        type: 'issue'
    }
    const project: ServiceObject = {
        id: 10001,
        name: 'name of project',
        type: 'project'
    }
    additionalData.push(issue)
    additionalData.push(project)


    const res = await syncedService.createTimeEntry(durationInMiliseconds, start, end, text, additionalData)
    console.log(res)
}


async function deleteTimeEntry(id: string | number) {
    const res = await syncedService.deleteTimeEntry(id)
    console.log(res)
}