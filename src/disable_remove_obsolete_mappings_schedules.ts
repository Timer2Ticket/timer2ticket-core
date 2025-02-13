import {databaseService} from './shared/database_service';
import {User} from './models/user';

disableRemoveObsoleteMappingsSchedules().then(() => process.exit(0));

async function disableRemoveObsoleteMappingsSchedules() {
    await databaseService.init();
    const users = await databaseService.getActiveUsers();
    for (const user of users) {
        await disableRemoveObsoleteMappingsSchedule(user);
    }
}

async function disableRemoveObsoleteMappingsSchedule(user: User) {
    const defaultSchedule = "0 0 1 1 */100";
    user.removeObsoleteMappingsJobDefinition = {
        "schedule": defaultSchedule,
        "lastSuccessfullyDone": null
    };
    await databaseService.updateUserRemoveObsoleteMappingsJobDefaultDefinition(user);
}

