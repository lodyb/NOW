import { Entity, PrimaryGeneratedColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Media } from './Media';
import { Tag } from './Tag';

@Entity('media_tags')
export class MediaTag {
  @PrimaryGeneratedColumn()
  id: number = 0;

  @ManyToOne(() => Media, (media) => media.mediaTags, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'media_id' })
  media!: Media;

  @ManyToOne(() => Tag, (tag) => tag.mediaTags, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tag_id' })
  tag!: Tag;
}