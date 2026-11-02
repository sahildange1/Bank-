import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { BeneficiariesService } from './beneficiaries.service';
import { CreateBeneficiaryDto } from './dto/create-beneficiary.dto';
import { UpdateBeneficiaryDto } from './dto/update-beneficiary.dto';
import { RejectBeneficiaryDto } from './dto/reject-beneficiary.dto';
import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthContext } from '../../common/types/auth-context';

@Controller('beneficiaries')
@UseGuards(SessionAuthGuard, PermissionsGuard)
export class BeneficiariesController {
  constructor(private readonly beneficiariesService: BeneficiariesService) {}

  @Get()
  // Gated on beneficiaries.read (added to the catalog after this controller
  // was first written — see the Phase 8 write-up), not create/approve:
  // BeneficiariesService.present() further masks the account number for
  // callers without beneficiaries.create/approve — see canSeeUnmasked().
  // Listing itself isn't the sensitive part, but it's still not something
  // every authenticated user should see without the org granting it.
  @RequirePermissions('beneficiaries.read')
  list(@CurrentUser() user: AuthContext) {
    return this.beneficiariesService.listBeneficiaries(user.organizationId, user.permissions);
  }

  @Get(':id')
  @RequirePermissions('beneficiaries.read')
  get(@CurrentUser() user: AuthContext, @Param('id') beneficiaryId: string) {
    return this.beneficiariesService.getBeneficiary(user.organizationId, beneficiaryId, user.permissions);
  }

  @Post()
  @RequirePermissions('beneficiaries.create')
  create(@CurrentUser() user: AuthContext, @Body() dto: CreateBeneficiaryDto) {
    return this.beneficiariesService.createBeneficiary(user.organizationId, user.userId, dto);
  }

  @Patch(':id')
  @RequirePermissions('beneficiaries.create')
  update(@CurrentUser() user: AuthContext, @Param('id') beneficiaryId: string, @Body() dto: UpdateBeneficiaryDto) {
    return this.beneficiariesService.updateBeneficiary(user.organizationId, user.userId, beneficiaryId, dto);
  }

  @Post(':id/verify')
  @RequirePermissions('beneficiaries.approve')
  verify(@CurrentUser() user: AuthContext, @Param('id') beneficiaryId: string) {
    return this.beneficiariesService.verifyBeneficiary(user.organizationId, user.userId, beneficiaryId);
  }

  @Post(':id/reject')
  @RequirePermissions('beneficiaries.approve')
  reject(@CurrentUser() user: AuthContext, @Param('id') beneficiaryId: string, @Body() dto: RejectBeneficiaryDto) {
    return this.beneficiariesService.rejectBeneficiary(user.organizationId, user.userId, beneficiaryId, dto);
  }

  // Disabling is risk-reducing, so it's gated at the lower
  // beneficiaries.create bar — see BeneficiariesService.disableBeneficiary
  // doc comment. Re-enabling is risk-adding, so it requires
  // beneficiaries.approve and resets verification — see enableBeneficiary.
  @Post(':id/disable')
  @RequirePermissions('beneficiaries.create')
  disable(@CurrentUser() user: AuthContext, @Param('id') beneficiaryId: string) {
    return this.beneficiariesService.disableBeneficiary(user.organizationId, user.userId, beneficiaryId);
  }

  @Post(':id/enable')
  @RequirePermissions('beneficiaries.approve')
  enable(@CurrentUser() user: AuthContext, @Param('id') beneficiaryId: string) {
    return this.beneficiariesService.enableBeneficiary(user.organizationId, user.userId, beneficiaryId);
  }
}
