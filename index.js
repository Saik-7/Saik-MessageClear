const { getModule, messages } = require('powercord/webpack');
const { Plugin } = require('powercord/entities');
const { get, del } = require('powercord/http');
const { sleep } = require('powercord/util');
const Settings = require('./components/Settings');

const { getChannelId } = getModule(['getLastSelectedChannelId'], false);
const { getCurrentUser } = getModule(['getCurrentUser'], false);
const { getToken } = getModule(['getToken'], false);

module.exports = class MessageCleaner extends Plugin {
   startPlugin() {
      this.pruning = {};

      if (!Array.prototype.chunk) {
         Object.defineProperty(Array.prototype, 'chunk', {
            value: function (size) {
               var array = [];
               for (var i = 0; i < this.length; i += size) {
                  array.push(this.slice(i, i + size));
               }
               return array;
            }
         });
      }

      if (!this.settings.get('aliases')) {
         this.settings.set('aliases', ['prune', 'purge', 'cl', 'pr']);
      }

      powercord.api.commands.registerCommand({
         command: 'clear',
         aliases: this.settings.get('aliases'),
         description: 'Apaga Mensagens.',
         usage: '{c} (quantia) [Ate o ID]',
         executor: (args) => this.clear(args)
      });

      powercord.api.settings.registerSettings('message-cleaner', {
         category: this.entityID,
         label: 'Message Cleaner',
         render: Settings
      });
   }

   pluginWillUnload() {
      powercord.api.commands.unregisterCommand('clear');
      powercord.api.settings.unregisterSettings('message-cleaner');
   }

   async clear(args) {
      const { BOT_AVATARS } = getModule(['BOT_AVATARS'], false);
      const { createBotMessage } = getModule(['createBotMessage'], false);

      this.channel = getChannelId();

      const receivedMessage = createBotMessage(this.channel, {});
      BOT_AVATARS.message_cleaner = 'https://media.discordapp.net/attachments/748937645387939860/814962064048521286/mi4.png';
      receivedMessage.author.username = "sly apagador";
      receivedMessage.author.avatar = 'message_cleaner';

      if (args.length === 0) {
         receivedMessage.content = 'Quantas apagar?';
         return messages.receiveMessage(receivedMessage.channel_id, receivedMessage);
      }

      if (this.pruning[this.channel] == true) {
         receivedMessage.content = `Comecando apagar`;
         return messages.receiveMessage(receivedMessage.channel_id, receivedMessage);
      }

      let count = args.shift();
      let before = args.shift();

      this.pruning[this.channel] = true;

      if (count !== 'all') {
         count = parseInt(count);
      }

      if (count <= 0 || count == NaN) {
         receivedMessage.content = 'A montagem deve ser especificada.';
         return messages.receiveMessage(receivedMessage.channel_id, receivedMessage);
      }

      receivedMessage.content = `Começando apagar.`;
      messages.receiveMessage(receivedMessage.channel_id, receivedMessage);

      let amount = this.settings.get('mode', 1) ? await this.burstDelete(count, before, this.channel) : await this.normalDelete(count, before, this.channel);

      delete this.pruning[this.channel];

      if (amount !== 0) {
         powercord.api.notices.sendToast(`CL_${this.channel}_${this.random(10)}`, {
            header: 'Terminei de apagar',
            content: `Deletei ${amount} mensagens no privado ID ${this.channel}.`,
            type: 'success',
            buttons: [
               {
                  text: 'Ok',
                  color: 'green',
                  size: 'small',
                  look: 'outlined'
               }
            ]
         });

         receivedMessage.content = `Foram deletadas ${amount} mensagens.`;
      } else {
         receivedMessage.content = `Não encontrei as mensagens`;
      }

      return messages.receiveMessage(receivedMessage.channel_id, receivedMessage);
   }

   async normalDelete(count, before, channel) {
      let deleted = 0;
      let offset = 0;
      while (count == 'all' || count > deleted) {
         if (count !== 'all' && count === deleted) break;
         let get = await this.fetch(channel, getCurrentUser().id, before, offset);
         if (get.messages.length <= 0 && get.skipped == 0) break;
         offset = get.offset;
         while (count !== 'all' && count < get.messages.length) get.messages.pop();
         for (const msg of get.messages) {
            await sleep(this.settings.get('normalDelay', 150));
            deleted += await this.deleteMsg(msg.id, channel);
         }
      }
      return deleted;
   }

   async burstDelete(count, before, channel) {
      let deleted = 0;
      let offset = 0;
      while (count == 'all' || count > deleted) {
         if (count !== 'all' && count === deleted) break;
         let get = await this.fetch(channel, getCurrentUser().id, before, offset);
         if (get.messages.length <= 0 && get.skipped == 0) break;
         offset = get.offset;
         while (count !== 'all' && count < get.messages.length) get.messages.pop();
         let chunk = get.messages.chunk(this.settings.get('chunkSize', 3));
         for (const msgs of chunk) {
            let funcs = [];
            for (const msg of msgs) {
               funcs.push(async () => {
                  return await this.deleteMsg(msg.id, channel);
               });
            }
            await Promise.all(
               funcs.map((f) => {
                  return f().then((amount) => {
                     deleted += amount;
                  });
               })
            );
            await sleep(this.settings.get('burstDelay', 1000));
         }
      }

      return deleted;
   }

   async deleteMsg(id, channel) {
      let deleted = 0;
      await del(`https://discord.com/api/v6/channels/${channel}/messages/${id}`)
         .set('User-Agent', navigator.userAgent)
         .set('Authorization', getToken())
         .then(() => {
            deleted++;
         })
         .catch(async (err) => {
            switch (err.statusCode) {
               case 404:
                  this.log(`Can't delete ${id} (Already deleted?)`);
                  break;
               case 429:
                  this.log(`Ratelimited while deleting ${id}. Waiting ${err.body.retry_after}ms`);
                  await sleep(err.body.retry_after);
                  deleted += await this.deleteMsg(id, channel);
                  break;
               default:
                  this.log(`Can't delete ${id} (Response: ${err.statusCode})`);
                  break;
            }
         });
      return deleted;
   }

   async fetch(channel, user, before, offset) {
      let out = [];
      let messages = await get(
         `https://discord.com/api/v6/channels/${channel}/messages/search?author_id=${user}${before ? `&max_id=${before}` : ''}${offset > 0 ? `&offset=${offset}` : ''}`
      )
         .set('User-Agent', navigator.userAgent)
         .set('Authorization', getToken())
         .catch(async (err) => {
            switch (err.statusCode) {
               case 429:
                  this.log(`Ratelimited while fetching. Waiting ${err.body.retry_after}ms`);
                  await sleep(err.body.retry_after);
                  return this.fetch(channel, user, before);
               default:
                  this.log(`Couldn't fetch (Response: ${err.statusCode})`);
                  break;
            }
         });
      if (messages.body.message && messages.body.message.startsWith('Index')) {
         await sleep(messages.body.retry_after);
         return this.fetch(channel, user, before, offset);
      }

      let msgs = messages.body.messages;
      if (!msgs.length) {
         return {
            messages: [],
            offset: offset,
            skipped: 0
         };
      }

      let skippedMsgs = 0;
      for (let bulk of msgs) {
         bulk = bulk.filter((msg) => msg.hit == true);
         out.push(...bulk.filter((msg) => msg.type === 0 || msg.type === 6));
         skippedMsgs += bulk.filter((msg) => !out.find((m) => m.id === msg.id)).length;
      }

      await sleep(this.settings.get('searchDelay', 200));

      return {
         messages: out.sort((a, b) => b.id - a.id),
         offset: skippedMsgs + offset,
         skipped: skippedMsgs
      };
   }

   async random(length) {
      var result = '';
      var characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      var charactersLength = characters.length;
      for (var i = 0; i < length; i++) {
         result += characters.charAt(Math.floor(Math.random() * charactersLength));
      }
      return result;
   }
};
