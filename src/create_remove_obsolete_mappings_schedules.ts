import {databaseService} from './shared/database_service';
import {User} from './models/user';

createRemoveObsoleteMappingsSchedules().then(() => process.exit(0));

async function createRemoveObsoleteMappingsSchedules() {
    await databaseService.init();
    const users = await databaseService.getActiveUsers();
    for (const user of users) {
        await createRemoveObsoleteMappingsSchedule(user);
    }
}

async function createRemoveObsoleteMappingsSchedule(user: User) {
    const defaultSchedule = "0 */24 * * *";
    const randomMinute = randomNumberBetween(0, 59);
    user.removeObsoleteMappingsJobDefinition = {
        "schedule": `${randomMinute}${defaultSchedule.substring(1)}`,
        "lastSuccessfullyDone": null
    }; // midnight + random minute, so the RM is not overloaded
    await databaseService.updateUserRemoveObsoleteMappingsJobDefaultDefinition(user);
}

function randomNumberBetween(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1) + min);
}
