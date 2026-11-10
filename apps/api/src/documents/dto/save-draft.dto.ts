import { contentMaxLength, SaveDraftInput } from '@reviewr/shared';
import { IsInt, IsString, MaxLength, Min } from 'class-validator';

/**
 * Body of `PUT /documents/:id/draft`.
 */
export class SaveDraftDto implements SaveDraftInput {
  @IsString()
  @MaxLength(contentMaxLength)
  public content: string;

  @IsInt()
  @Min(1)
  public draftVersion: number;
}
