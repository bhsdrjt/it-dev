import { BadRequestException, Body, Controller, Delete, Get, HttpException, Param, Post, Put, Query, Req, ServiceUnavailableException, UseGuards, UseInterceptors } from '@nestjs/common';
import { AuthAuditInterceptor, AuthRequest, JwtGuard, RequirePermissions } from './auth';
import { DbService } from './db';
import { PcService } from './pc';
import { PcRegistryService } from './registry';
import { integer, object, pcInput, queryInteger, sqlDateTime, text } from './validation';
@Controller()
@UseGuards(JwtGuard)
@UseInterceptors(AuthAuditInterceptor)
export class ApiController {
  constructor(private readonly registry: PcRegistryService, private readonly pc: PcService, private readonly db: DbService) { }
  private async reference<T>(label: string, read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    }
    catch (error) {
      if (error instanceof HttpException && error.getStatus() === 503) throw new ServiceUnavailableException(`${label}: ${error.message}`);
      throw error;
    }
  }
  @RequirePermissions('equipment.view')
  @Get('apis') async apis() {
    return Promise.all((await this.registry.list()).map(pc => this.pc.status(pc)));
  }
  @RequirePermissions('equipment.ping')
  @Post('apis/ping') async ping(@Body() body: unknown) {
    const data = object(body ?? {});
    const pcs = data.apiId === undefined ? await this.registry.list() : [await this.registry.get(text(data.apiId, 'ID API'))];
    return Promise.all(pcs.map(pc => this.pc.status(pc)));
  }
  private async validatePc(body: unknown) {
    const data = pcInput(body);
    const locations = await this.reference(`API ${data.apiName} (${data.ipAPI})`, () => this.db.locations());
    const invalid = data.locationIDs.filter(id => !locations.some(location => location.LocationID === id));
    if (invalid.length) throw new BadRequestException(`API ${data.apiName} (${data.ipAPI}): LocationID ${invalid.join(', ')} tidak terdaftar sebagai lokasi aktif type 7.`);
    return data;
  }
  @RequirePermissions('equipment.manage_pc')
  @Post('apis') async add(@Body() body: unknown) {
    return this.registry.save(await this.validatePc(body));
  }
  @RequirePermissions('equipment.manage_pc')
  @Put('apis/:id') async edit(@Param('id') id: string, @Body() body: unknown) {
    return this.registry.save(await this.validatePc(body), id);
  }
  @RequirePermissions('equipment.manage_pc')
  @Delete('apis/:id') remove(@Param('id') id: string) {
    return this.registry.remove(id);
  }
  @RequirePermissions('equipment.view', 'monitoring.view', 'transactions.view', 'timeline.view')
  @Get('equipments') equipments(@Query('activeOnly') activeOnly?: unknown) {
    if (activeOnly !== undefined && activeOnly !== 'true' && activeOnly !== 'false') throw new BadRequestException('activeOnly harus true atau false.');
    return this.db.equipments(activeOnly === 'true');
  }
  @RequirePermissions('transactions.copy_loading')
  @Post('transactions/salin-muatan')
  salinMuatan(@Body() body: unknown) {
    const data = object(body);
    const cdn = text(data.coalDeliveryNumber, 'CoalDeliveryNumber');
    const truck = text(data.nextDT, 'NoTruck');
    if (!/^[\x20-\x7E]{1,20}$/.test(cdn) || !/^[\x20-\x7E]{1,8}$/.test(truck)) throw new BadRequestException('SK maksimal 20 dan NoTruck maksimal 8 karakter ASCII tanpa karakter kontrol.');
    if (data.confirmed !== true) throw new BadRequestException('Konfirmasi Salin Muatan diperlukan.');
    return this.db.salinMuatan(cdn, truck);
  }
  @RequirePermissions('transactions.copy_loading')
  @Get('transactions/salin-muatan/candidates')
  salinMuatanCandidates(@Query('coalDeliveryNumber') coalDeliveryNumber: unknown, @Query('nextDT') nextDT: unknown) {
    const cdn = text(coalDeliveryNumber, 'CoalDeliveryNumber');
    const truck = text(nextDT, 'NoTruck');
    if (!/^[\x20-\x7E]{1,20}$/.test(cdn) || !/^[\x20-\x7E]{1,8}$/.test(truck)) throw new BadRequestException('SK maksimal 20 dan NoTruck maksimal 8 karakter ASCII tanpa karakter kontrol.');
    return this.db.salinMuatanCandidates(cdn, truck);
  }
  @RequirePermissions('transactions.copy_loading')
  @Post('transactions/salin-muatan/ke-terima-ada')
  salinMuatanKeTerimaAda(@Body() body: unknown) {
    const data = object(body);
    const cdn = text(data.coalDeliveryNumber, 'CoalDeliveryNumber');
    const truck = text(data.nextDT, 'NoTruck');
    if (!/^[\x20-\x7E]{1,20}$/.test(cdn) || !/^[\x20-\x7E]{1,8}$/.test(truck)) throw new BadRequestException('SK maksimal 20 dan NoTruck maksimal 8 karakter ASCII tanpa karakter kontrol.');
    const id = integer(data.ctFinalDumpingTonnageId, 'CTFinalDumpingTonnageID');
    if (id <= 0) throw new BadRequestException('CTFinalDumpingTonnageID harus integer positif.');
    if (data.confirmed !== true) throw new BadRequestException('Konfirmasi Salin Muatan diperlukan.');
    return this.db.salinMuatanKeTerimaAda(cdn, truck, id);
  }
  @RequirePermissions('transactions.generate_receipt')
  @Post('transactions/generate-sk-terima')
  generateSkTerima(@Body() body: unknown) {
    const data = object(body);
    const cdn = text(data.coalDeliveryNumber, 'CoalDeliveryNumber');
    if (!/^[\x20-\x7E]{1,20}$/.test(cdn)) throw new BadRequestException('CoalDeliveryNumber maksimal 20 karakter ASCII tanpa karakter kontrol.');
    if (data.confirmed !== true) throw new BadRequestException('Konfirmasi Generate SK Terima diperlukan.');
    return this.db.generateSkTerima(cdn);
  }
  @RequirePermissions('transactions.delete')
  @Post('transactions/delete')
  deleteTransaction(@Body() body: unknown) {
    const data = object(body);
    if (data.kind !== 'Kirim' && data.kind !== 'Terima') throw new BadRequestException('Jenis transaksi harus Kirim atau Terima.');
    const id = integer(data.tonnageId, 'CTFinalTonnageID');
    if (id <= 0) throw new BadRequestException('CTFinalTonnageID harus integer positif.');
    if (data.confirmed !== true) throw new BadRequestException('Konfirmasi penghapusan diperlukan.');
    return this.db.deleteTransaction(data.kind, id);
  }
  @RequirePermissions('transactions.restore')
  @Post('transactions/restore')
  restoreTransaction(@Body() body: unknown) {
    const data = object(body);
    if (data.kind !== 'Kirim' && data.kind !== 'Terima') throw new BadRequestException('Jenis transaksi harus Kirim atau Terima.');
    const id = integer(data.tonnageId, 'CTFinalTonnageID');
    if (id <= 0) throw new BadRequestException('CTFinalTonnageID harus integer positif.');
    if (data.confirmed !== true) throw new BadRequestException('Konfirmasi pemulihan diperlukan.');
    return this.db.restoreTransaction(data.kind, id);
  }
  @RequirePermissions('monitoring.view')
  @Get('anomalies')
  anomalies(@Query('start') start: unknown, @Query('end') end: unknown, @Query('code') code: unknown, @Query('truck') truck: unknown, @Query('cdn') cdn: unknown, @Query('severity') severity: unknown, @Query('category') category: unknown) {
    const from = sqlDateTime(start, 'start');
    const to = end === undefined ? new Date() : sqlDateTime(end, 'end');
    if (+to <= +from) throw new BadRequestException('end harus setelah start.');
    const optional = (value: unknown, name: string, max: number) => value === undefined ? undefined : text(value, name).slice(0, max);
    if (severity !== undefined && severity !== 'critical' && severity !== 'warning') throw new BadRequestException('severity harus critical atau warning.');
    if (category !== undefined && category !== 'pairing' && category !== 'location' && category !== 'time') throw new BadRequestException('category harus pairing, location, atau time.');
    return this.db.anomalies(from, to, {
      code: optional(code, 'code', 50), truck: optional(truck, 'truck', 50), cdn: optional(cdn, 'cdn', 50),
      severity: optional(severity, 'severity', 10), category: optional(category, 'category', 20)
    });
  }
  @RequirePermissions('equipment.view', 'monitoring.view', 'transactions.view', 'timeline.view')
  @Get('locations') locations() {
    return this.db.locations();
  }
  @RequirePermissions('coal.view')
  @Get('coal-calories') coalCalories() {
    return this.db.coalCalories();
  }
  @RequirePermissions('coal.import')
  @Put('coal-calories/:id/import') importCoalCalory(@Param('id') id: string, @Body() body: unknown) {
    return this.updateCoalCalory(id, body);
  }
  @RequirePermissions('coal.update')
  @Put('coal-calories/:id') updateCoalCalory(@Param('id') id: string, @Body() body: unknown) {
    const rowId = queryInteger(id, 'CoalQualityAGMID');
    if (rowId <= 0) throw new BadRequestException('CoalQualityAGMID harus integer positif.');
    const data = object(body);
    if (typeof data.coalQualityName !== 'string' || !data.coalQualityName.trim() || data.coalQualityName.length > 255) throw new BadRequestException('CoalQualityName wajib diisi (maksimal 255 karakter).');
    const name = data.coalQualityName.trim();
    if (data.coalcalory !== null && !Number.isSafeInteger(data.coalcalory)) throw new BadRequestException('Coalcalory harus integer atau null.');
    const calory = data.coalcalory === null ? null : integer(data.coalcalory, 'Coalcalory');
    return this.db.updateCoalCalory(rowId, name, calory);
  }
  @RequirePermissions('coal.delete')
  @Delete('coal-calories/:id') deleteCoalCalory(@Param('id') id: string, @Body() body: unknown) {
    const rowId = queryInteger(id, 'CoalQualityAGMID');
    if (rowId <= 0) throw new BadRequestException('CoalQualityAGMID harus integer positif.');
    if (object(body ?? {}).confirmed !== true) throw new BadRequestException('Konfirmasi penghapusan diperlukan.');
    return this.db.deleteTransaction('CoalCalory', rowId);
  }
  @RequirePermissions('timeline.view')
  @Get('transactions/truck-history')
  truckHistory(@Query('equipmentId') equipmentId: unknown, @Query('starttime') starttime: unknown, @Query('endtime') endtime: unknown) {
    const id = queryInteger(equipmentId, 'EquipmentID');
    if (id <= 0) throw new BadRequestException('EquipmentID harus integer positif.');
    const start = sqlDateTime(starttime, 'starttime');
    const end = sqlDateTime(endtime, 'endtime');
    if (+end < +start) throw new BadRequestException('endtime tidak boleh sebelum starttime.');
    return this.db.truckHistory(id, start, end);
  }
  // Timeline dibaca; replay RawTerima hanya melalui POST terkonfirmasi.
  @RequirePermissions('transactions.view', 'timeline.view')
  @Get('transactions/timeline')
  timeline(@Query('coalDeliveryNumber') value: unknown) {
    const coalDeliveryNumber = text(value, 'CoalDeliveryNumber');
    if (coalDeliveryNumber.length > 50 || !/^[\x20-\x7E]+$/.test(coalDeliveryNumber)) throw new BadRequestException('CoalDeliveryNumber harus teks ASCII tanpa karakter kontrol (maksimal 50 karakter).');
    return this.db.truckTimeline(coalDeliveryNumber);
  }
  @RequirePermissions('transactions.view', 'timeline.view')
  @Get('transactions/detail')
  transactionDetail(@Query('kind') kind: unknown, @Query('tonnageId') value: unknown) {
    if (kind !== 'Kirim' && kind !== 'Terima') throw new BadRequestException('Jenis transaksi harus Kirim atau Terima.');
    const id = queryInteger(value, 'ID transaksi');
    if (id <= 0) throw new BadRequestException('ID transaksi harus integer positif.');
    return this.db.transactionDetail(kind, id);
  }
  @RequirePermissions('transactions.view', 'timeline.view')
  @Get('transactions/relations')
  relatedTransactions(@Query('kind') kind: unknown, @Query('dumpingTonnageId') value: unknown) {
    if (kind !== 'Kirim' && kind !== 'Terima') throw new BadRequestException('Jenis transaksi harus Kirim atau Terima.');
    const id = queryInteger(value, 'CTFinalDumpingTonnageID');
    if (id <= 0) throw new BadRequestException('CTFinalDumpingTonnageID harus integer positif.');
    return this.db.relatedTransactions(kind, id);
  }
  @RequirePermissions('transactions.view')
  @Get('transactions/loading-location')
  previewLoadingLocation(@Query('loadingTonnageId') value: unknown) {
    const id = queryInteger(value, 'CTFinalLoadingTonnageID');
    if (id <= 0) throw new BadRequestException('CTFinalLoadingTonnageID harus integer positif.');
    return this.db.previewLoadingLocation(id);
  }
  @RequirePermissions('transactions.view')
  @Post('transactions/loading-location')
  updateLoadingLocation(@Body() body: unknown, @Req() request: AuthRequest) {
    const data = object(body);
    const id = integer(data.loadingTonnageId, 'CTFinalLoadingTonnageID');
    if (id <= 0) throw new BadRequestException('CTFinalLoadingTonnageID harus integer positif.');
    if (typeof data.previewToken !== 'string' || !/^[a-fA-F0-9]{64}$/.test(data.previewToken)) throw new BadRequestException('Token preview harus SHA256 64 karakter hex.');
    if (data.confirmed !== true) throw new BadRequestException('Konfirmasi Get LoadingLocation diperlukan.');
    return this.db.updateLoadingLocation(id, data.previewToken, request.auth.userId);
  }
  @RequirePermissions('transactions.pair')
  @Post('transactions/relations/pair')
  pairRelation(@Body() body: unknown) {
    const data = object(body);
    const loadingTonnageId = integer(data.loadingTonnageId, 'CTFinalLoadingTonnageID');
    if (loadingTonnageId <= 0) throw new BadRequestException('CTFinalLoadingTonnageID harus integer positif.');
    if (data.confirmed !== true) throw new BadRequestException('Konfirmasi pemasangan relasi diperlukan.');
    return this.db.pairLoadingRelation(loadingTonnageId);
  }
  @RequirePermissions('transactions.unpair')
  @Post('transactions/relations')
  releaseRelation(@Body() body: unknown) {
    const data = object(body);
    const loadingTonnageId = integer(data.loadingTonnageId, 'CTFinalLoadingTonnageID');
    if (loadingTonnageId <= 0) throw new BadRequestException('CTFinalLoadingTonnageID harus integer positif.');
    if (data.confirmed !== true) throw new BadRequestException('Konfirmasi pelepasan relasi diperlukan.');
    return this.db.releaseLoadingRelation(loadingTonnageId);
  }
  @RequirePermissions('transactions.replay_raw')
  @Post('transactions/raw-terima')
  promoteRawDumping(@Body() body: unknown) {
    const data = object(body);
    const rawTonnageId = integer(data.rawTonnageId, 'CTFinalDumpingTonnageRawID');
    if (rawTonnageId <= 0) throw new BadRequestException('CTFinalDumpingTonnageRawID harus integer positif.');
    if (data.confirmed !== true) throw new BadRequestException('Konfirmasi pemrosesan RawTerima diperlukan.');
    return this.db.promoteRawDumping(rawTonnageId);
  }
  @RequirePermissions('equipment.view')
  @Get('equipment-checks') async checks(@Query('apiId') apiId: unknown) {
    const pc = await this.registry.get(text(apiId, 'ID API'));
    if (!(await this.pc.status(pc)).online) throw new ServiceUnavailableException(`${this.pc.label(pc)} offline. Data tidak dimuat.`);
    const rows = await this.pc.checks(pc);
    const [equipment, locations] = await this.reference(this.pc.label(pc), () => Promise.all([this.db.equipments(), this.db.locations()]));
    const equipmentNames = new Map(equipment.map(row => [row.EquipmentID, row.strTruckCN]));
    const locationNames = new Map(locations.map(row => [row.LocationID, row.strLocationName]));
    return rows.map(row => ({ ...row, equipmentName: equipmentNames.get(row.equipmentID) ?? `Equipment #${row.equipmentID}`, locationName: locationNames.get(row.locationID) ?? `Lokasi #${row.locationID}` }));
  }
  @RequirePermissions('equipment.view')
  @Get('equipment-checks/location') async lookup(@Query('apiId') apiId: unknown, @Query('equipmentId') equipmentId: unknown) {
    const pc = await this.registry.get(text(apiId, 'ID API'));
    const id = queryInteger(equipmentId, 'EquipmentID');
    await this.pc.requireTcp(pc);
    if (!(await this.reference(this.pc.label(pc), () => this.db.equipment(id))).length) throw new BadRequestException(`${this.pc.label(pc)}: EquipmentID ${id} tidak terdaftar.`);
    const locations = await this.reference(this.pc.label(pc), () => this.db.locations());
    const checkedLocationIDs: number[] = [];
    // Periksa sesuai urutan registry. Error request langsung menghentikan pencarian:
    // koneksi gagal tidak sama dengan konfigurasi tidak ditemukan.
    for (const locationID of pc.locationIDs) {
      checkedLocationIDs.push(locationID);
      // ponytail: PRD tidak menetapkan endpoint lookup API; GET collection dengan filter lalu cocokkan pasangan secara lokal. Sesuaikan saat kontrak API tersedia.
      const rows = await this.pc.checks(pc, { equipmentID: id, locationID }, Number(process.env.LOOKUP_TIMEOUT_MS || 6000));
      if (rows.some(row => row.equipmentID === id && row.locationID === locationID)) return { locationID, locationName: locations.find(row => row.LocationID === locationID)?.strLocationName ?? `Lokasi #${locationID}`, checkedLocationIDs, message: `${this.pc.label(pc)}: lokasi ditemukan.` };
    }
    return { locationID: null, locationName: null, checkedLocationIDs, message: `${this.pc.label(pc)}: konfigurasi equipment ${id} tidak ditemukan pada lokasi terdaftar.` };
  }
  @RequirePermissions('equipment.configure')
  @Post('equipment-checks/upsert') async upsert(@Body() body: unknown) {
    const data = object(body);
    const pc = await this.registry.get(text(data.apiId, 'ID API'));
    const equipmentID = integer(data.equipmentID, 'EquipmentID');
    const locationID = 0;
    if (typeof data.isGenerateCDN !== 'boolean') throw new BadRequestException(`${this.pc.label(pc)}: isGenerateCDN harus boolean.`);
    await this.pc.requireTcp(pc);
    if (!(await this.reference(this.pc.label(pc), () => this.db.equipment(equipmentID))).length) throw new BadRequestException(`${this.pc.label(pc)}: EquipmentID ${equipmentID} tidak terdaftar.`);
    await this.pc.request(pc, 'POST', { data: { equipmentID, locationID, isGenerateCDN: data.isGenerateCDN }, timeout: 10000 });
    return { message: `${this.pc.label(pc)}: konfigurasi equipment ${equipmentID}, lokasi ${locationID}, berhasil dikirim.` };
  }
}
