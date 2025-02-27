// SPDX-License-Identifier: GPL-3.0-or-later
/*
    Animal Rights Advocates Discord Bot
    Copyright (C) 2022  Anthony Berg

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { container, Listener } from '@sapphire/framework';
import type {
  CategoryChannel,
  ColorResolvable,
  TextChannel,
  VoiceChannel,
  VoiceState,
  GuildMember,
  Guild,
  User,
} from 'discord.js';
import {
  ButtonInteraction,
  Constants,
  MessageActionRow,
  MessageButton,
  MessageEmbed,
} from 'discord.js';
import { time } from '@discordjs/builders';
import { maxVCs, questionInfo, serverFind } from '../../utils/verificationConfig';
import { joinVerification, startVerification, finishVerification } from '../../utils/database/verification';
import { findNotes } from '../../utils/database/sus';
import { userExists, addExistingUser } from '../../utils/database/dbExistingUser';
import { rolesToString } from '../../utils/formatter';
import IDs from '../../utils/ids';

class VerificationJoinVCListener extends Listener {
  public constructor(context: Listener.Context, options: Listener.Options) {
    super(context, {
      ...options,
      event: 'voiceStateUpdate',
    });
  }

  public async run(oldState: VoiceState, newState: VoiceState) {
    // If the event was not a user joining the channel
    if (oldState.channel?.parent?.id === IDs.categories.verification
      || newState.channel?.parent?.id !== IDs.categories.verification
    ) {
      return;
    }

    // Variable if this channel is a Verifiers only VC
    let verifier = false;

    // Checks for not null
    const { channel } = newState;
    const { member } = newState;
    const { client } = container;
    const guild = client.guilds.cache.get(newState.guild.id);

    if (channel === null || member === null || guild === undefined) {
      console.error('Verification channel not found');
      return;
    }

    // Get current category and channel
    const categoryGuild = guild.channels.cache.get(IDs.categories.verification);
    const currentChannelGuild = guild.channels.cache.get(channel.id);
    if (currentChannelGuild === undefined || categoryGuild === undefined) {
      console.error('Verification channel not found');
      return;
    }
    const currentChannel = currentChannelGuild as VoiceChannel;
    const category = categoryGuild as CategoryChannel;

    const roles = rolesToString(member.roles.cache.map((r) => r.id));

    // Check if a verifier joined a verification VC and update database
    if (channel.members.size === 2) {
      await channel.permissionOverwrites.edit(guild.roles.everyone, {
        SEND_MESSAGES: true,
      });

      if (!channel.name.includes(' - Verification')) {
        return;
      }

      await startVerification(channel.id);
      return;
    }

    // Checks if there is more than one person who has joined or if the channel has members
    if (channel.members.size !== 1
      || !channel.members.has(member.id)) {
      return;
    }

    // Check if the user has the verifiers role
    if (member.roles.cache.has(IDs.roles.staff.verifier)
      || member.roles.cache.has(IDs.roles.staff.trialVerifier)) {
      await channel.setName('Verifier Meeting');
      verifier = true;
    } else {
      await channel.setName(`${member.displayName} - Verification`);
      await currentChannel.send(`Hiya ${member.user}, please be patient as a verifier has been called out to verify you.\n\n`
      + 'If you leave this voice channel, you will automatically be given the non-vegan role where you gain access to this server and if you\'d like to verify as a vegan again, you\'d have to contact a Mod, which could be done via ModMail.');
      // Adds to the database that the user joined verification
      await joinVerification(channel.id, member);

      // Remove all roles from the user
      await member.roles.remove([
        IDs.roles.vegan.vegan,
        IDs.roles.trusted,
        IDs.roles.nonvegan.nonvegan,
        IDs.roles.nonvegan.convinced,
        IDs.roles.nonvegan.vegCurious,
      ]);

      // Start 15-minute timer if verifier does not join
      // @ts-ignore
      this.container.tasks.create('verifyTimeout', {
        channelId: channel.id,
        userId: member.id,
      }, 900_000); // 15 minutes
    }

    // Check how many voice channels there are
    const listVoiceChannels = category.children.filter((c) => c.type === 'GUILD_VOICE');

    // Create a text channel for verifiers only
    // Checks if there are more than 10 voice channels
    if (!verifier) {
      const verificationText = await guild.channels.create(`✅┃${member.displayName}-verification`, {
        type: 'GUILD_TEXT',
        topic: `Channel for verifiers only. ${member.id} ${channel.id} (Please do not change this)`,
        parent: category.id,
        userLimit: 1,
        permissionOverwrites: [
          {
            id: guild.roles.everyone,
            deny: ['SEND_MESSAGES', 'VIEW_CHANNEL'],
          },
          {
            id: IDs.roles.verifyBlock,
            deny: ['VIEW_CHANNEL', 'SEND_MESSAGES'],
          },
          {
            id: IDs.roles.staff.verifier,
            allow: ['SEND_MESSAGES', 'VIEW_CHANNEL'],
          },
          {
            id: IDs.roles.staff.trialVerifier,
            allow: ['SEND_MESSAGES', 'VIEW_CHANNEL'],
          },
        ],
      });

      // Send a message that someone wants to be verified
      const userInfoEmbed = await this.getUserInfo(member, roles);
      const susNotes = await this.getSus(member, guild);
      await verificationText.send({
        content: `${member.user} wants to be verified in ${channel}
      \n<@&${IDs.roles.staff.verifier}> <@&${IDs.roles.staff.trialVerifier}>`,
        embeds: [userInfoEmbed, susNotes],
      });

      await this.verificationProcess(verificationText, channel.id, member, guild);
    }

    // Create a new channel for others to join

    // Checks if there are more than 10 voice channels
    if (listVoiceChannels.size > maxVCs - 1) {
      await guild.channels.create('Verification', {
        type: 'GUILD_VOICE',
        parent: category.id,
        userLimit: 1,
        permissionOverwrites: [
          {
            id: guild.roles.everyone,
            deny: ['SEND_MESSAGES', 'VIEW_CHANNEL'],
          },
          {
            id: IDs.roles.verifyBlock,
            deny: ['VIEW_CHANNEL', 'CONNECT', 'SEND_MESSAGES'],
          },
          {
            id: IDs.roles.nonvegan.nonvegan,
            allow: ['VIEW_CHANNEL'],
            deny: ['CONNECT'],
          },
          {
            id: IDs.roles.vegan.vegan,
            allow: ['VIEW_CHANNEL'],
            deny: ['CONNECT'],
          },
          {
            id: IDs.roles.vegan.activist,
            deny: ['VIEW_CHANNEL', 'CONNECT'],
          },
          {
            id: IDs.roles.staff.verifier,
            allow: ['SEND_MESSAGES', 'VIEW_CHANNEL', 'CONNECT', 'MUTE_MEMBERS'],
          },
          {
            id: IDs.roles.staff.trialVerifier,
            allow: ['SEND_MESSAGES', 'VIEW_CHANNEL', 'CONNECT', 'MUTE_MEMBERS'],
          },
        ],
      });
    } else {
      await guild.channels.create('Verification', {
        type: 'GUILD_VOICE',
        parent: category.id,
        userLimit: 1,
        permissionOverwrites: [
          {
            id: guild.roles.everyone,
            deny: ['SEND_MESSAGES', 'VIEW_CHANNEL'],
          },
          {
            id: IDs.roles.verifyBlock,
            deny: ['VIEW_CHANNEL', 'CONNECT', 'SEND_MESSAGES'],
          },
          {
            id: IDs.roles.nonvegan.nonvegan,
            allow: ['VIEW_CHANNEL'],
          },
          {
            id: IDs.roles.vegan.vegan,
            allow: ['VIEW_CHANNEL'],
          },
          {
            id: IDs.roles.vegan.activist,
            deny: ['VIEW_CHANNEL', 'CONNECT'],
          },
          {
            id: IDs.roles.staff.verifier,
            allow: ['SEND_MESSAGES', 'VIEW_CHANNEL', 'CONNECT', 'MUTE_MEMBERS'],
          },
          {
            id: IDs.roles.staff.trialVerifier,
            allow: ['SEND_MESSAGES', 'VIEW_CHANNEL', 'CONNECT', 'MUTE_MEMBERS'],
          },
        ],
      });
    }

    // Change permissions to join the current channel
    await currentChannel.permissionOverwrites.set([
      {
        id: guild.roles.everyone,
        deny: ['SEND_MESSAGES', 'VIEW_CHANNEL'],
      },
      {
        id: IDs.roles.verifyBlock,
        deny: ['VIEW_CHANNEL', 'CONNECT', 'SEND_MESSAGES'],
      },
      {
        id: IDs.roles.staff.verifier,
        allow: ['SEND_MESSAGES', 'VIEW_CHANNEL', 'CONNECT', 'MUTE_MEMBERS'],
      },
      {
        id: IDs.roles.staff.trialVerifier,
        allow: ['SEND_MESSAGES', 'VIEW_CHANNEL', 'CONNECT', 'MUTE_MEMBERS'],
      },
      {
        id: member.id,
        allow: ['VIEW_CHANNEL'],
      },
    ]);
    await currentChannel.setUserLimit(0);
  }

  // Creates an embed for information about the user
  private async getUserInfo(user: GuildMember, roles: string) {
    const joinTime = time(user.joinedAt!);
    const registerTime = time(user.user.createdAt);

    const embed = new MessageEmbed()
      .setColor(user.displayHexColor)
      .setTitle(`Information on ${user.user.username}`)
      .setThumbnail(user.user.avatarURL()!)
      .addFields(
        { name: 'Joined:', value: `${joinTime}`, inline: true },
        { name: 'Created:', value: `${registerTime}`, inline: true },
        { name: 'Roles:', value: roles },
      );

    return embed;
  }

  // Creates the embed to display the sus note
  private async getSus(user: GuildMember, guild: Guild) {
    const notes = await findNotes(user.id, true);

    const embed = new MessageEmbed()
      .setColor(user.displayHexColor)
      .setTitle(`${notes.length} sus notes for ${user.user.username}`);

    // Add up to 10 of the latest sus notes to the embed
    for (let i = notes.length > 10 ? notes.length - 10 : 0; i < notes.length; i += 1) {
      // Get mod name
      const modGuildMember = guild.members.cache.get(notes[i].modId);
      let mod = notes[i].modId;
      if (modGuildMember !== undefined) {
        mod = modGuildMember.displayName;
      }
      // Add sus note to embed
      embed.addFields({
        name: `Sus ID: ${notes[i].id} | Moderator: ${mod} | Date: <t:${Math.floor(notes[i].time.getTime() / 1000)}>`,
        value: notes[i].note,
      });
    }

    return embed;
  }

  private async verificationProcess(
    channel: TextChannel,
    verId: string,
    user: GuildMember,
    guild: Guild,
  ) {
    const embedColor = '#0099ff';
    const info = {
      page: 0,
      find: {
        reason: 0,
        where: 0,
      },
      length: 0,
      reasoning: 0,
      life: 0,
      food: 0,
      roles: {
        vegan: false,
        activist: false,
        trusted: false,
        vegCurious: false,
        convinced: false,
      },
    };

    // TODO add a variable that tells if each order has a reversed value, e.g. 0-3 or 3-0
    const questionLength = questionInfo.length;

    let embed = await this.createEmbed(questionInfo[0].question, embedColor);
    let buttons = await this.createButtons(questionInfo[0].buttons);

    // Sends the note to verify this note is to be deleted
    const message = await channel.send({
      embeds: [embed],
      components: buttons,
    });

    // Listen for the button presses
    const collector = channel.createMessageComponentCollector({
      // max: 2, // Maximum of 1 button press
    });

    // Button pressed
    collector.on('collect', async (button: ButtonInteraction) => {
      // Select roles
      if (button.customId.includes('button')) {
        await button.deferUpdate();
        // Get the button choice
        const buttonChoice = this.getButtonValue(button.customId);
        if (Number.isNaN(buttonChoice)) {
          return;
        }
        // Set the value of the button choice to the page the question was on
        switch (info.page) {
          case 0: {
            info.find.reason = buttonChoice;
            if (buttonChoice !== 0 && info.find.reason === 0) {
              embed = await this.createEmbed(serverFind[info.page].question, embedColor);
              buttons = await this.createButtons(serverFind[info.page].buttons);
              await message.edit({
                embeds: [embed],
                components: buttons,
              });
              return;
            }
            if (info.find.reason !== 0) {
              info.find.where = buttonChoice;
            }
            break;
          }
          case 1: {
            info.length = buttonChoice;
            break;
          }
          case 2: {
            info.reasoning = buttonChoice;
            break;
          }
          case 3: {
            info.life = buttonChoice;
            break;
          }
          case 4: {
            info.food = buttonChoice;
            break;
          }
          // If they are definitely vegan or not
          case 5: {
            if (buttonChoice === 0) {
              info.roles.vegan = true;
              info.roles.trusted = true;
            } else {
              info.page += 1;
            }
            break;
          }
          // If they are vegan but should get activist role
          case 6: {
            if (buttonChoice === 0) {
              info.roles.activist = true;
            }
            info.page += 1;
            break;
          }
          // If they should get vegan, convinced or non-vegan
          case 7: {
            if (buttonChoice === 0) {
              info.roles.vegan = true;
            } else if (buttonChoice === 1) {
              info.roles.convinced = true;
            }
            break;
          }
          case 8: {
            if (buttonChoice === 0) {
              info.roles.vegCurious = true;
            }
            break;
          }
          default: {
            console.error('Button clicked out of range');
            return;
          }
        }
        info.page += 1;
        // Checks if finished all the questions
        if (info.page < questionLength) {
          embed = await this.createEmbed(questionInfo[info.page].question, embedColor);
          buttons = await this.createButtons(questionInfo[info.page].buttons);
          await message.edit({
            embeds: [embed],
            components: buttons,
          });
        }
        // Confirmation to give roles to the user being verified
        if (info.page === questionLength) {
          // Create embed with all the roles the user has
          embed = new MessageEmbed()
            .setColor(embedColor)
            .setTitle(`Give these roles to ${user.displayName}?`)
            .setThumbnail(user.avatarURL()!)
            .addFields(
              { name: 'Roles:', value: this.getTextRoles(info.roles) },
            );

          // Create buttons for input
          buttons = [new MessageActionRow<MessageButton>()
            .addComponents(
              new MessageButton()
                .setCustomId('confirm')
                .setLabel('Yes')
                .setStyle(Constants.MessageButtonStyles.SUCCESS),
              new MessageButton()
                .setCustomId('cancel')
                .setLabel('No')
                .setStyle(Constants.MessageButtonStyles.DANGER),
            )];
          await message.edit({
            embeds: [embed],
            components: buttons,
          });
        }
      }
      // Confirming and finishing the verification
      if (button.customId === 'confirm' && info.page >= questionLength) {
        // Check verifier is on the database
        const verifierGuildMember = await guild.members.cache.get(button.user.id);
        if (verifierGuildMember === undefined) {
          await message.edit({ content: 'Verifier not found!' });
          return;
        }
        // Add verifier to database if they're not on the database
        if (!(await userExists(verifierGuildMember))) {
          await addExistingUser(verifierGuildMember);
        }

        // Add verification data to database
        await finishVerification(verId, button.user.id, info);
        // Give roles on Discord
        await this.giveRoles(user, info.roles);
        // Add timeout if they do not have activist role
        if (!info.roles.activist) {
          // @ts-ignore
          this.container.tasks.create('verifyUnblock', {
            userId: user.id,
            guildId: guild.id,
          }, (info.roles.vegan || info.roles.convinced) ? 604800000 : 1814400000);
        }
        // Add embed saying verification completed
        embed = new MessageEmbed()
          .setColor('#34c000')
          .setTitle(`Successfully verified ${user.displayName}!`)
          .setThumbnail(user.user.avatarURL()!)
          .addFields(
            { name: 'Roles:', value: this.getTextRoles(info.roles) },
          );
        await message.edit({
          embeds: [embed],
          components: [],
        });
        // Send welcome message after verification
        await this.finishMessages(user.user, info.roles);
      }
      if (button.customId === 'cancel' && info.page >= questionLength) {
        info.page = 5;
        info.roles.vegan = false;
        info.roles.activist = false;
        info.roles.trusted = false;
        info.roles.vegCurious = false;
        info.roles.convinced = false;
        embed = await this.createEmbed(questionInfo[info.page].question, embedColor);
        buttons = await this.createButtons(questionInfo[info.page].buttons);
        await message.edit({
          embeds: [embed],
          components: buttons,
        });
        await button.deferUpdate();
      }
    });
  }

  private async createEmbed(title: string, color: ColorResolvable) {
    return new MessageEmbed()
      .setColor(color)
      .setTitle(title);
  }

  private async createButtons(buttons: string[]) {
    const buttonActions = [];

    for (let i = 0; i < buttons.length; i += 1) {
      // Check if it exceeds the maximum buttons in a ActionRow
      if (i % 5 === 0) {
        buttonActions.push(new MessageActionRow<MessageButton>());
      }
      buttonActions[Math.floor(i / 5)]
        .addComponents(
          new MessageButton()
            .setCustomId(`button${i}`)
            .setLabel(buttons[i])
            .setStyle(Constants.MessageButtonStyles.SECONDARY),
        );
    }

    return buttonActions;
  }

  // Finds the value of the choice in the button
  private getButtonValue(button: string) {
    const buttonChoice = button.at(button.length - 1);
    if (buttonChoice === undefined) {
      return NaN;
    }
    return parseInt(buttonChoice, 10);
  }

  private getTextRoles(
    roles: {
      vegan: boolean,
      activist: boolean,
      trusted: boolean,
      vegCurious: boolean,
      convinced: boolean
    },
  ) {
    let rolesText = '';
    if (roles.convinced) {
      rolesText += `<@&${IDs.roles.nonvegan.convinced}>`;
    }
    if (roles.vegan) {
      rolesText += `<@&${IDs.roles.vegan.vegan}>`;
    } else {
      rolesText += `<@&${IDs.roles.nonvegan.nonvegan}>`;
    }
    if (roles.activist) {
      rolesText += `<@&${IDs.roles.vegan.activist}>`;
    }
    if (roles.trusted) {
      rolesText += `<@&${IDs.roles.trusted}>`;
    }
    if (roles.vegCurious) {
      rolesText += `<@&${IDs.roles.nonvegan.vegCurious}>`;
    }
    return rolesText;
  }

  private async giveRoles(
    user: GuildMember,
    roles: {
      vegan: boolean,
      activist: boolean,
      trusted: boolean,
      vegCurious: boolean,
      convinced: boolean
    },
  ) {
    const rolesAdd = [];
    if (roles.convinced) {
      rolesAdd.push(IDs.roles.nonvegan.convinced);
    }
    if (roles.vegan) {
      rolesAdd.push(IDs.roles.vegan.vegan);
    } else {
      rolesAdd.push(IDs.roles.nonvegan.nonvegan);
    }
    if (roles.activist) {
      rolesAdd.push(IDs.roles.vegan.activist);
    } else {
      rolesAdd.push(IDs.roles.verifyBlock);
    }
    if (roles.trusted) {
      rolesAdd.push(IDs.roles.trusted);
    }
    if (roles.vegCurious) {
      rolesAdd.push(IDs.roles.nonvegan.vegCurious);
    }
    await user.roles.add(rolesAdd);
  }

  // Messages after verifying the user
  private async finishMessages(user: User, roles: {
    vegan: boolean,
    activist: boolean,
    trusted: boolean,
    vegCurious: boolean,
    convinced: boolean
  }) {
    // Send a DM with when their verification is finished
    await this.finishDM(user, roles)
      .catch(() => console.error('Verification: Closed DMs'));

    // Not vegan
    if (!roles.vegan) {
      const general = this.container.client.channels.cache.get(IDs.channels.nonVegan.general) as TextChannel | undefined;
      if (general === undefined) {
        return;
      }
      let msg = `${user}, you have been verified! Please check <#${IDs.channels.information.roles}> `
        + `and remember to follow the <#${IDs.channels.information.conduct}> and to respect ongoing discussion and debates.`;
      // Add extra info if the user got veg curious or convinced.
      if (roles.vegCurious || roles.convinced) {
        msg += `\n\nYou also have access to <#${IDs.channels.dietSupport.main}> for help on going vegan.`;
      }
      await general.send(msg);
      return;
    }

    // Vegan
    const general = this.container.client.channels.cache.get(IDs.channels.vegan.general) as TextChannel | undefined;
    if (general === undefined) {
      return;
    }
    const msg = `Welcome ${user}! Please check out <#${IDs.channels.information.roles}> :)`;
    await general.send(msg);

    // Activist role
    if (roles.activist) {
      const activist = this.container.client.channels.cache.get(IDs.channels.activism.activism) as TextChannel | undefined;
      if (activist === undefined) {
        return;
      }
      const activistMsg = `${user} you have been given the activist role! This means that if you'd wish to engage with non-vegans in `
        + `<#${IDs.channels.nonVegan.general}>, you should follow these rules:\n\n`
        + '1. Try to move conversations with non-vegans towards veganism/animal ethics\n'
        + '2. Don\'t discuss social topics while activism is happening\n'
        + '3. Have evidence for claims you make. "I don\'t know" is an acceptable answer. Chances are someone here knows or you can take time to find out\n'
        + '4. Don\'t advocate for baby steps towards veganism. Participation in exploitation can stop today\n'
        + '5. Differences in opinion between activists should be resolved in vegan spaces, not in the chat with non-vegans';
      await activist.send(activistMsg);
    }
  }

  // Messages after verifying the user
  private async finishDM(user: User, roles: {
    vegan: boolean,
    activist: boolean,
    trusted: boolean,
    vegCurious: boolean,
    convinced: boolean
  }) {
    if (!roles.vegan && !roles.convinced) {
      const message = 'You\'ve been verified as non-vegan!'
        + `\n\nYou can next verify on ${time(Math.round(Date.now() / 1000) + 1814400)}`;

      await user.send(message);
    } else if (roles.convinced) {
      const message = 'You\'ve been verified as convinced!'
        + `\n\nYou can next verify on ${time(Math.round(Date.now() / 1000) + 604800)}`;

      await user.send(message);
    } else if (roles.vegan && !roles.activist) {
      const message = 'You\'ve been verified as a vegan!'
        + `\n\nYou can next get verified on ${time(Math.round(Date.now() / 1000) + 604800)} if you would wish to have the activist role.`;

      await user.send(message);
    }
  }
}

export default VerificationJoinVCListener;
