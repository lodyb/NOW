import { Entity, PrimaryGeneratedColumn, Column, OneToMany } from 'typeorm';
import { MediaTag } from './MediaTag';

@Entity('tags')
export class Tag {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true })
  name!: string;

  @OneToMany(() => MediaTag, (mediaTag) => mediaTag.tag)
  mediaTags!: MediaTag[];
}