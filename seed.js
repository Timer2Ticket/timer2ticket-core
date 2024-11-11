db = db.getSiblingDB('timer2ticketDB');

db.users.insertOne({
    id: ObjectId(),
    username: "test_user",
    passwordHash: "HASH",
    registrated: Date(),
    status: "active",
    config: {
        plan: "SUPER",
        daysToSync: 1
    },
    configSyncJobDefinition: {
        schedule: "10 * * * *",
        lastSuccessfullyDone: null,
    },
    timeEntrySyncJobDefinition: {
        schedule: "10 * * * *",
        lastSuccessfullyDone: null,
    },
    serviceDefinitions: [
        {
            name: 'Redmine',
            apiKey: '',
            isPrimary: true,
            config: {
                apiPoint: 'https://projects.jagu.cz/'
            }
        }
    ]
});