import { Entity, PrimaryGeneratedColumn, Column, ManyToOne } from 'typeorm';
import { Media } from './Media';

@Entity('media_answers')
export class MediaAnswer {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Media, (media) => media.answers, { onDelete: 'CASCADE' })
  media!: Media;

  @Column()
  answer!: string;

  @Column({ default: false })
  isPrimary!: boolean;
}