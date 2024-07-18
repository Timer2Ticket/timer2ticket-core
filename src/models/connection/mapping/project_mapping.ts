export class ProjectMapping {
    idFirstService!: number | string
    idSecondService!: number | string

    constructor(idFirstService: number | string, idSecondService: number | string) {
        this.idFirstService = idFirstService
        this.idSecondService = idSecondService
    }
}