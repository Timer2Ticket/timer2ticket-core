export class ProjectMapping {
    idFirstService!: number | string
    idSecondService!: number | string

    constructor(idFirstSercice: number | string, idSecondService: number | string) {
        this.idFirstService = idFirstSercice
        this.idSecondService = idSecondService
    }
}